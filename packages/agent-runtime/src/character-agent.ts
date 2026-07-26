import {
  CharacterAgentRequestSchema,
  CharacterAgentResultSchema,
  MeetingCharacterOutputSchema,
  type CharacterAgentRequest,
  type CharacterAgentResult,
  type CharacterConsistencyReport,
  type EngineMeetingType,
  type MeetingCharacterOutput,
} from "@mandate/domain";
import type { LLMGenerateOptions, LLMMessage, LLMResult } from "@mandate/llm-adapters";
import {
  composeCharacterPrompt,
  type ComposedPrompt,
  type MeetingPromptContext,
} from "@mandate/prompt-system";
import { CharacterAgentError } from "./errors";
import { CharacterContextBuilder, type CharacterAgentContext } from "./character-context-builder";
import { evaluateCharacterConsistency } from "./character-consistency-evaluator";
import { generateCharacterOutputWithRepair } from "./output-repair";

/**
 * 单人物 Character Agent（§11，ADR-014）。
 * 编排：请求校验 → revision 一致性 → 可交谈检查 → 上下文构建 → Prompt 组合
 * → Provider 调用（含受控修复）→ 一致性检查 → 组装结果。
 * 红线：本类没有任何状态写入口——不 touch GameState、SQLite、StateChangeLog。
 */

export interface CharacterAgentLlm {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResult>;
}

export interface CharacterAgentOptions {
  /** 结构化输出最大修复次数（默认 1，可配置） */
  maxRepairAttempts?: number;
  clock?: { now(): Date };
}

export interface CharacterAgentResponse {
  readonly result: CharacterAgentResult;
  readonly consistency: CharacterConsistencyReport;
  readonly context: CharacterAgentContext;
  readonly prompt: Pick<ComposedPrompt, "manifest" | "budget">;
}

/** Phase 4：会议回合请求（transcript 已由调用方按该角色可见性过滤） */
export interface MeetingAgentTurnRequest {
  readonly saveId: string;
  readonly characterId: string;
  readonly meetingType: EngineMeetingType;
  readonly meetingPrompt: MeetingPromptContext;
  readonly participantIds: readonly string[];
  readonly input: { readonly speakerId: string; readonly text: string };
  readonly topic?: string;
  readonly expectedRevision: number;
  /** 该角色可见的席间回合 id（一致性检查用） */
  readonly visibleTurnIds: readonly string[];
}

export interface MeetingAgentTurnResponse {
  readonly output: MeetingCharacterOutput;
  readonly repaired: boolean;
  readonly provider: string;
  readonly model: string;
  readonly consistency: CharacterConsistencyReport;
  readonly context: CharacterAgentContext;
  readonly prompt: Pick<ComposedPrompt, "manifest" | "budget">;
  readonly stateRevision: number;
  readonly durationMs: number;
}

export class CharacterAgent {
  private readonly maxRepairAttempts: number;
  private readonly clock: { now(): Date };

  constructor(
    private readonly contextBuilder: CharacterContextBuilder,
    private readonly llm: CharacterAgentLlm,
    options: CharacterAgentOptions = {},
  ) {
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async respond(inputRequest: CharacterAgentRequest): Promise<CharacterAgentResponse> {
    const request = CharacterAgentRequestSchema.parse(inputRequest);
    const startedAt = this.clock.now().getTime();

    const context = await this.contextBuilder.build(request);

    if (context.trace.revision !== request.expectedRevision) {
      throw new CharacterAgentError(
        "CHARACTER_CONTEXT_STALE",
        `状态已前进：期望 revision ${request.expectedRevision}，当前 ${context.trace.revision}`,
      );
    }
    if (context.runtime.status !== "active") {
      throw new CharacterAgentError(
        "CHARACTER_NOT_AVAILABLE",
        `人物当前不可交谈（${context.runtime.status}）：${request.characterId}`,
      );
    }

    const participants = context.conversation.participantIds.map((id) => ({
      id,
      name:
        id === "emperor"
          ? "皇帝"
          : (context.view.knownCharacters.find((item) => item.value.characterId === id)?.value
              .name ?? (id === request.characterId ? context.template.name : id)),
    }));

    const composed = await composeCharacterPrompt({
      scenarioName: context.scenarioName,
      template: context.template,
      view: context.view,
      mode: context.conversation.mode,
      ...(context.conversation.topic === undefined ? {} : { topic: context.conversation.topic }),
      participants,
      previousTurns: context.conversation.previousTurns,
      input: context.conversation.input,
    });

    const messages: LLMMessage[] = [
      { role: "system", content: composed.system },
      ...composed.messages,
    ];
    const generation = await generateCharacterOutputWithRepair(
      { generate: (value) => this.llm.generate(value) },
      messages,
      { maxRepairAttempts: this.maxRepairAttempts },
    );

    const consistency = evaluateCharacterConsistency({
      template: context.template,
      view: context.view,
      mode: context.conversation.mode,
      output: generation.output,
      mustNotReveal: context.constraints.mustNotReveal,
      venueRestricted: context.constraints.venueRestricted,
    });
    if (!consistency.passed) {
      throw new CharacterAgentError(
        "CHARACTER_CONSISTENCY_FAILED",
        "人物输出未通过一致性检查",
        consistency,
      );
    }

    const durationMs = Math.max(0, this.clock.now().getTime() - startedAt);
    const result = CharacterAgentResultSchema.parse({
      ...generation.output,
      characterId: request.characterId,
      trace: {
        provider: generation.provider,
        model: generation.model,
        promptVersions: composed.manifest.promptVersions,
        stateRevision: context.trace.revision,
        durationMs,
        repaired: generation.repaired,
      },
    });

    return {
      result,
      consistency,
      context,
      prompt: { manifest: composed.manifest, budget: composed.budget },
    };
  }

  /**
   * Phase 4：会议中的单回合应对（§11）。
   * 复用同一条链路（视图→记忆→组合→修复→一致性），仅追加会议上下文段与会议输出契约；
   * 本方法同样没有任何状态写操作。
   */
  async respondInMeeting(request: MeetingAgentTurnRequest): Promise<MeetingAgentTurnResponse> {
    const startedAt = this.clock.now().getTime();
    const agentRequest = CharacterAgentRequestSchema.parse({
      saveId: request.saveId,
      characterId: request.characterId,
      mode: request.meetingType,
      input: request.input,
      participantIds: [...request.participantIds],
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      expectedRevision: request.expectedRevision,
    });

    const context = await this.contextBuilder.build(agentRequest);
    if (context.trace.revision !== request.expectedRevision) {
      throw new CharacterAgentError(
        "CHARACTER_CONTEXT_STALE",
        `状态已前进：期望 revision ${request.expectedRevision}，当前 ${context.trace.revision}`,
      );
    }
    if (context.runtime.status !== "active") {
      throw new CharacterAgentError(
        "CHARACTER_NOT_AVAILABLE",
        `人物当前不可与会（${context.runtime.status}）：${request.characterId}`,
      );
    }

    const participants = context.conversation.participantIds.map((id) => ({
      id,
      name:
        id === "emperor"
          ? "皇帝"
          : (context.view.knownCharacters.find((item) => item.value.characterId === id)?.value
              .name ?? (id === request.characterId ? context.template.name : id)),
    }));

    const composed = await composeCharacterPrompt({
      scenarioName: context.scenarioName,
      template: context.template,
      view: context.view,
      mode: context.conversation.mode,
      ...(context.conversation.topic === undefined ? {} : { topic: context.conversation.topic }),
      participants,
      previousTurns: [],
      input: context.conversation.input,
      meetingContext: request.meetingPrompt,
    });

    const messages: LLMMessage[] = [
      { role: "system", content: composed.system },
      ...composed.messages,
    ];
    const generation = await generateCharacterOutputWithRepair(
      { generate: (value) => this.llm.generate(value) },
      messages,
      {
        maxRepairAttempts: this.maxRepairAttempts,
        schema: MeetingCharacterOutputSchema,
        contractPromptIds: ["output.character-response", "output.meeting-character-response"],
      },
    );

    const consistency = evaluateCharacterConsistency({
      template: context.template,
      view: context.view,
      mode: context.conversation.mode,
      output: generation.output,
      mustNotReveal: context.constraints.mustNotReveal,
      venueRestricted: context.constraints.venueRestricted,
      visibleTurnIds: request.visibleTurnIds,
      referencedTurnIds: generation.output.referencedTurnIds,
    });
    if (!consistency.passed) {
      throw new CharacterAgentError(
        "CHARACTER_CONSISTENCY_FAILED",
        "人物会议输出未通过一致性检查",
        consistency,
      );
    }

    return {
      output: generation.output,
      repaired: generation.repaired,
      provider: generation.provider,
      model: generation.model,
      consistency,
      context,
      prompt: { manifest: composed.manifest, budget: composed.budget },
      stateRevision: context.trace.revision,
      durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
    };
  }
}
