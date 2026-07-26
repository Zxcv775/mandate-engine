import {
  toCharacterPublicResponse,
  type CharacterAgentRequest,
  type CharacterMemory,
  type CharacterMemoryQuery,
  type CharacterPublicProfile,
  type CharacterPublicResponse,
  type CharacterRespondRequest,
  type CharacterSummary,
  type CharacterTemplate,
  type GameState,
  type Institution,
  type Office,
} from "@mandate/domain";
import type { ScenarioLoader } from "@mandate/data-loader";
import {
  CharacterAgent,
  CharacterAgentError,
  CharacterContextBuilder,
  evaluateMemoryCandidates,
  type CharacterAgentResponse,
} from "@mandate/agent-runtime";
import { PromptBudgetExceededError } from "@mandate/prompt-system";
import { LLMProviderError, estimateTokens } from "@mandate/llm-adapters";
import type { CharacterMemoryRepository, GameStateService } from "@mandate/save-system";
import type { RuntimeConfig } from "../config/index";
import { ApiError } from "../errors/api-error";
import type { LlmService, LlmServiceLogger } from "./llm-service";

/**
 * Character Service（§13）：人物 API 的应用服务层。
 * 职责：装配 Character Agent、审批并落库记忆候选、保存对话记录、
 * 输出公开投影与安全审计日志。
 * 红线：本服务不提交任何 GameState Command——Agent 调用不改变世界状态。
 */

export interface CharacterServiceOptions {
  gameStateService: GameStateService;
  memories: CharacterMemoryRepository;
  scenarioLoader: ScenarioLoader;
  llm: LlmService;
  config: RuntimeConfig;
  logger: LlmServiceLogger;
}

export interface CharacterRespondDebugInfo {
  consistency: { passed: boolean; violationCount: number; warnings: readonly string[] };
  memorySelection: {
    selectedCount: number;
    excludedCount: number;
    estimatedTokens: number;
  };
  promptBudget: {
    totalCharacters: number;
    totalEstimatedTokens: number;
    trimmed: readonly string[];
  };
  promptVersions: Readonly<Record<string, string>>;
  repaired: boolean;
  acceptedMemoryCandidates: number;
  rejectedMemoryCandidates: number;
}

export interface CharacterRespondOutcome {
  response: CharacterPublicResponse;
  debug: CharacterRespondDebugInfo;
}

interface ScenarioTemplates {
  scenarioName: string;
  characters: CharacterTemplate[];
  offices: Office[];
  institutions: Institution[];
}

function mapAgentError(error: unknown): never {
  if (error instanceof CharacterAgentError) {
    const statusByCode: Record<string, number> = {
      CHARACTER_NOT_FOUND: 404,
      CHARACTER_NOT_AVAILABLE: 409,
      CHARACTER_CONTEXT_STALE: 409,
      CHARACTER_VIEW_BUILD_FAILED: 500,
      CHARACTER_MEMORY_INVALID: 422,
      CHARACTER_MEMORY_LIMIT_EXCEEDED: 409,
      CHARACTER_OUTPUT_INVALID: 502,
      CHARACTER_CONSISTENCY_FAILED: 502,
      PROMPT_BUDGET_EXCEEDED: 500,
      LLM_OUTPUT_REPAIR_FAILED: 502,
    };
    throw new ApiError(statusByCode[error.code] ?? 500, error.code, error.message);
  }
  if (error instanceof PromptBudgetExceededError) {
    throw new ApiError(500, "PROMPT_BUDGET_EXCEEDED", "人物上下文超出预算");
  }
  if (error instanceof LLMProviderError) {
    throw new ApiError(502, "PROVIDER_REQUEST_FAILED", "语言模型调用失败");
  }
  throw error;
}

export class CharacterService {
  private readonly templatesByScenario = new Map<string, Promise<ScenarioTemplates>>();

  constructor(private readonly options: CharacterServiceOptions) {}

  private loadTemplates(scenarioId: string): Promise<ScenarioTemplates> {
    let cached = this.templatesByScenario.get(scenarioId);
    if (!cached) {
      cached = this.options.scenarioLoader.loadScenarioBundle(scenarioId).then((bundle) => ({
        scenarioName: bundle.scenario.name,
        // Bundle 为 deep-frozen 只读结构，克隆为可传递的普通对象
        characters: structuredClone(bundle.characters) as CharacterTemplate[],
        offices: structuredClone(bundle.offices) as Office[],
        institutions: structuredClone(bundle.institutions) as Institution[],
      }));
      this.templatesByScenario.set(scenarioId, cached);
    }
    return cached;
  }

  private async loadSaveContext(saveId: string): Promise<{
    state: GameState;
    templates: ScenarioTemplates;
  }> {
    const metadata = await this.options.gameStateService.getSave(saveId);
    const [state, templates] = await Promise.all([
      this.options.gameStateService.loadState(saveId),
      this.loadTemplates(metadata.scenarioId),
    ]);
    return { state, templates };
  }

  private static isAvailable(state: GameState, characterId: string): boolean {
    return state.characters[characterId]?.status === "active";
  }

  async listCharacters(saveId: string): Promise<CharacterSummary[]> {
    const { state, templates } = await this.loadSaveContext(saveId);
    return Object.values(state.characters)
      .map((runtime) => {
        const template = templates.characters.find((value) => value.id === runtime.characterId);
        if (!template) return undefined;
        return {
          characterId: runtime.characterId,
          name: template.name,
          currentOfficeId: runtime.officeId,
          status: runtime.status,
          availableForAudience: runtime.status === "active",
          publicTags: template.politicalProfile.factionIds,
        } satisfies CharacterSummary;
      })
      .filter((value) => value !== undefined)
      .sort((a, b) => a.characterId.localeCompare(b.characterId));
  }

  async getPublicProfile(saveId: string, characterId: string): Promise<CharacterPublicProfile> {
    const { state, templates } = await this.loadSaveContext(saveId);
    const runtime = state.characters[characterId];
    const template = templates.characters.find((value) => value.id === characterId);
    if (!runtime || !template) {
      throw new ApiError(404, "CHARACTER_NOT_FOUND", `人物不存在：${characterId}`);
    }
    return {
      characterId,
      name: template.name,
      ...(template.identity.courtesyName === undefined
        ? {}
        : { courtesyName: template.identity.courtesyName }),
      aliases: [...template.identity.aliases],
      ...(template.identity.birthYear === undefined
        ? {}
        : { birthYear: template.identity.birthYear }),
      historicalSummary: template.historicalProfile.summary,
      historicalReputation: [...template.historicalProfile.historicalReputation],
      publicPositions: [...template.politicalProfile.publicPositions],
      factionIds: [...template.politicalProfile.factionIds],
      currentOfficeId: runtime.officeId,
      status: runtime.status,
      availableForAudience: runtime.status === "active",
    };
  }

  private async createAgent(saveId: string): Promise<{
    agent: CharacterAgent;
    templates: ScenarioTemplates;
  }> {
    const metadata = await this.options.gameStateService.getSave(saveId);
    const templates = await this.loadTemplates(metadata.scenarioId);
    const contextBuilder = new CharacterContextBuilder(
      {
        loadHeadState: (id) => this.options.gameStateService.loadState(id),
        listMemories: (id, characterId) =>
          this.options.memories.listMemories(id, characterId, { limit: 200 }).memories,
        listRecentTurns: (id, characterId, limit) =>
          this.options.memories.listRecentTurns(id, characterId, limit),
      },
      templates,
    );
    const agent = new CharacterAgent(
      contextBuilder,
      { generate: (messages) => this.options.llm.generateText(messages) },
      { maxRepairAttempts: this.options.config.character.maxRepairAttempts },
    );
    return { agent, templates };
  }

  async respond(
    saveId: string,
    characterId: string,
    request: CharacterRespondRequest,
    requestId: string,
  ): Promise<CharacterRespondOutcome> {
    const agentRequest: CharacterAgentRequest = {
      saveId,
      characterId,
      mode: request.mode,
      input: request.input,
      ...(request.participantIds === undefined ? {} : { participantIds: request.participantIds }),
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      expectedRevision: request.expectedRevision,
      requestId,
    };

    const { agent } = await this.createAgent(saveId);
    let outcome: CharacterAgentResponse;
    const startedAt = performance.now();
    try {
      outcome = await agent.respond(agentRequest);
    } catch (error) {
      this.logAgentCall(requestId, agentRequest, undefined, error);
      return mapAgentError(error);
    }

    // 记忆候选：Schema 校验 → Memory Policy → 落库（Agent 无直接写权限）
    const existing = this.options.memories.listMemories(saveId, characterId, {
      limit: 200,
    }).memories;
    const decision = evaluateMemoryCandidates({
      candidates: outcome.result.memoryCandidates,
      existingMemories: existing,
      limits: { maxPerCharacter: this.options.config.character.memoryMaxPerCharacter },
    });
    for (const accepted of decision.accepted) {
      this.options.memories.insertMemory({
        saveId,
        characterId,
        candidate: accepted.candidate,
        confidence: accepted.adjustedConfidence,
        sourceRevision: outcome.result.trace.stateRevision,
      });
    }
    this.options.memories.touchRecall(outcome.context.memories.map((memory) => memory.memoryId));
    this.options.memories.insertTurn({
      saveId,
      characterId,
      speakerId: request.input.speakerId,
      mode: request.mode,
      inputText: request.input.text,
      speech: outcome.result.speech,
      stateRevision: outcome.result.trace.stateRevision,
      promptVersions: { ...outcome.prompt.manifest.promptVersions },
    });

    const durationMs = Math.round(performance.now() - startedAt);
    this.logAgentCall(requestId, agentRequest, {
      outcome,
      durationMs,
      accepted: decision.accepted.length,
      rejected: decision.rejected.length,
    });

    return {
      response: toCharacterPublicResponse(outcome.result),
      debug: {
        consistency: {
          passed: outcome.consistency.passed,
          violationCount: outcome.consistency.violations.length,
          warnings: outcome.consistency.violations
            .filter((violation) => violation.severity === "warning")
            .map((violation) => `${violation.code}: ${violation.message}`),
        },
        memorySelection: {
          selectedCount: outcome.context.memories.length,
          excludedCount: outcome.context.memorySelection.excludedCount,
          estimatedTokens: outcome.context.memorySelection.estimatedTokens,
        },
        promptBudget: {
          totalCharacters: outcome.prompt.budget.totalCharacters,
          totalEstimatedTokens: outcome.prompt.budget.totalEstimatedTokens,
          trimmed: outcome.prompt.budget.trimmed,
        },
        promptVersions: outcome.prompt.manifest.promptVersions,
        repaired: outcome.result.trace.repaired,
        acceptedMemoryCandidates: decision.accepted.length,
        rejectedMemoryCandidates: decision.rejected.length,
      },
    };
  }

  /** Debug：构建上下文摘要（不调用 LLM，不返回完整系统 Prompt / API Key） */
  async debugContext(saveId: string, characterId: string) {
    const { state, templates } = await this.loadSaveContext(saveId);
    if (!state.characters[characterId]) {
      throw new ApiError(404, "CHARACTER_NOT_FOUND", `人物不存在：${characterId}`);
    }
    const contextBuilder = new CharacterContextBuilder(
      {
        loadHeadState: () => state,
        listMemories: (id, character) =>
          this.options.memories.listMemories(id, character, { limit: 200 }).memories,
        listRecentTurns: (id, character, limit) =>
          this.options.memories.listRecentTurns(id, character, limit),
      },
      templates,
    );
    try {
      const context = await contextBuilder.build({
        saveId,
        characterId,
        mode: "general",
        input: { speakerId: "emperor", text: "（调试上下文预览）" },
        expectedRevision: state.revision,
      });
      return {
        characterId,
        revision: context.trace.revision,
        view: {
          knownCountryFields: Object.keys(context.view.knownCountryState),
          knownCharacterCount: context.view.knownCharacters.length,
          knownPolicyCount: context.view.knownPolicies.length,
          knownMeetingCount: context.view.knownMeetings.length,
          uncertainties: context.view.uncertainties,
        },
        memories: {
          selected: context.memories.map((memory: CharacterMemory) => ({
            memoryId: memory.memoryId,
            type: memory.type,
            importance: memory.importance,
            confidence: memory.confidence,
            status: memory.status,
          })),
          excludedCount: context.memorySelection.excludedCount,
        },
        constraints: {
          outputLanguage: context.constraints.outputLanguage,
          historicalRegister: context.constraints.historicalRegister,
          venueRestrictedCount: context.constraints.venueRestricted.length,
        },
      };
    } catch (error) {
      return mapAgentError(error);
    }
  }

  listMemoriesForDebug(saveId: string, characterId: string, query: CharacterMemoryQuery) {
    const { memories, nextCursor } = this.options.memories.listMemories(saveId, characterId, {
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.topic === undefined ? {} : { topic: query.topic }),
      ...(query.relatedCharacterId === undefined
        ? {}
        : { relatedCharacterId: query.relatedCharacterId }),
      ...(query.fromRevision === undefined ? {} : { fromRevision: query.fromRevision }),
      ...(query.toRevision === undefined ? {} : { toRevision: query.toRevision }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    // sealed 记忆即便在 Debug API 也需要额外授权，本阶段一律不返回内容
    return {
      memories: memories.filter((memory) => memory.visibility !== "sealed"),
      nextCursor,
    };
  }

  private logAgentCall(
    requestId: string,
    request: CharacterAgentRequest,
    success?: {
      outcome: CharacterAgentResponse;
      durationMs: number;
      accepted: number;
      rejected: number;
    },
    error?: unknown,
  ): void {
    const base = {
      event: "character_agent_call",
      requestId,
      saveId: request.saveId,
      characterId: request.characterId,
      mode: request.mode,
      expectedRevision: request.expectedRevision,
      inputCharacters: request.input.text.length,
    };
    if (success) {
      this.options.logger.info({
        ...base,
        stateRevision: success.outcome.result.trace.stateRevision,
        provider: success.outcome.result.trace.provider,
        model: success.outcome.result.trace.model,
        promptVersions: success.outcome.prompt.manifest.promptVersions,
        durationMs: success.durationMs,
        repaired: success.outcome.result.trace.repaired,
        consistencyPassed: success.outcome.consistency.passed,
        outputCharacters: success.outcome.result.speech.length,
        estimatedPromptTokens: success.outcome.prompt.budget.totalEstimatedTokens,
        estimatedOutputTokens: estimateTokens(success.outcome.result.speech),
        memoryCandidatesAccepted: success.accepted,
        memoryCandidatesRejected: success.rejected,
        success: true,
      });
    } else {
      this.options.logger.error({
        ...base,
        success: false,
        errorCode:
          error instanceof CharacterAgentError
            ? error.code
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
    }
  }
}
