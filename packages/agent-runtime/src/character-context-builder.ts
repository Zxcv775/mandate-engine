import type {
  CharacterAgentRequest,
  CharacterConversationMode,
  CharacterConversationTurn,
  CharacterMemory,
  CharacterRuntimeState,
  CharacterStateView,
  CharacterTemplate,
  GameState,
  Institution,
  Office,
} from "@mandate/domain";
import {
  DEFAULT_CHARACTER_CONTEXT_BUDGET,
  type CharacterContextBudget,
} from "@mandate/prompt-system";
import { CharacterAgentError } from "./errors";
import { buildCharacterView } from "./character-view-builder";
import { selectRelevantMemories } from "./memory/memory-selector";

/**
 * Character Context Builder（§10）。
 * 只读装配：统一 GameState → 视图过滤 → 记忆选择 → 上下文对象。
 * 不修改任何状态、不调用 LLM；同一输入必得同一输出。
 */

export interface CharacterContextPorts {
  loadHeadState(saveId: string): GameState | Promise<GameState>;
  listMemories(
    saveId: string,
    characterId: string,
  ): readonly CharacterMemory[] | Promise<readonly CharacterMemory[]>;
  listRecentTurns(
    saveId: string,
    characterId: string,
    limit: number,
  ): readonly CharacterConversationTurn[] | Promise<readonly CharacterConversationTurn[]>;
}

export interface CharacterContextTemplates {
  readonly scenarioName: string;
  readonly characters: readonly CharacterTemplate[];
  readonly offices: readonly Office[];
  readonly institutions: readonly Institution[];
}

export interface CharacterAgentContext {
  readonly scenarioName: string;
  readonly template: CharacterTemplate;
  readonly runtime: CharacterRuntimeState;
  readonly view: CharacterStateView;
  readonly memories: readonly CharacterMemory[];
  readonly memorySelection: {
    readonly excludedCount: number;
    readonly totalCharacters: number;
    readonly estimatedTokens: number;
  };
  readonly conversation: {
    readonly mode: CharacterConversationMode;
    readonly topic?: string;
    readonly participantIds: readonly string[];
    readonly previousTurns: readonly CharacterConversationTurn[];
    readonly input: { speakerId: string; speakerLabel: string; text: string };
  };
  readonly constraints: {
    readonly mustNotReveal: readonly string[];
    readonly venueRestricted: readonly string[];
    readonly outputLanguage: "zh-CN";
    readonly historicalRegister: string;
  };
  readonly trace: { readonly saveId: string; readonly revision: number };
}

/** 无论上下文如何组合，这些字符串都不允许出现在人物输出中 */
const STATIC_MUST_NOT_REVEAL: readonly string[] = [
  "<character-data>",
  "<known-world-state>",
  "<character-memories>",
  "<conversation-input>",
  "系统提示词",
  "system prompt",
];

export class CharacterContextBuilder {
  constructor(
    private readonly ports: CharacterContextPorts,
    private readonly templates: CharacterContextTemplates,
    private readonly budget: CharacterContextBudget = DEFAULT_CHARACTER_CONTEXT_BUDGET,
  ) {}

  async build(request: CharacterAgentRequest): Promise<CharacterAgentContext> {
    const state = await this.ports.loadHeadState(request.saveId);
    const template = this.templates.characters.find((value) => value.id === request.characterId);
    const runtime = state.characters[request.characterId];
    if (!template || !runtime) {
      throw new CharacterAgentError("CHARACTER_NOT_FOUND", `人物不存在：${request.characterId}`);
    }

    const participantIds =
      request.participantIds ?? [request.input.speakerId, request.characterId];
    const topicIds = request.topic === undefined ? [] : [request.topic];

    const allMemories = await this.ports.listMemories(request.saveId, request.characterId);
    const selection = selectRelevantMemories({
      memories: allMemories,
      context: {
        mode: request.mode,
        topicIds,
        participantIds,
        currentRevision: state.revision,
      },
      budget: {
        maxItems: this.budget.maxMemoryItems,
        maxCharacters: 4_000,
        maxEstimatedTokens: 2_000,
      },
    });

    const view = buildCharacterView({
      state,
      characterId: request.characterId,
      context: { mode: request.mode, participantIds, topicIds },
      memories: selection.selected,
      templates: this.templates,
    });

    const previousTurns = await this.ports.listRecentTurns(
      request.saveId,
      request.characterId,
      this.budget.maxConversationTurns,
    );

    const speakerLabel =
      request.input.speakerId === "emperor"
        ? "皇帝"
        : (this.templates.characters.find((value) => value.id === request.input.speakerId)?.name ??
          request.input.speakerId);

    // 公开场合不得提及的机密：该角色参与过的秘密议事/单独召见
    const venueRestricted = view.knownMeetings
      .filter(
        (meeting) =>
          (meeting.value.type === "secret-council" || meeting.value.type === "private-audience") &&
          meeting.value.participantIds.includes(request.characterId),
      )
      .map((meeting) => meeting.value.meetingId);

    return {
      scenarioName: this.templates.scenarioName,
      template,
      runtime,
      view,
      memories: selection.selected,
      memorySelection: {
        excludedCount: selection.excludedCount,
        totalCharacters: selection.totalCharacters,
        estimatedTokens: selection.estimatedTokens,
      },
      conversation: {
        mode: request.mode,
        ...(request.topic === undefined ? {} : { topic: request.topic }),
        participantIds,
        previousTurns,
        input: {
          speakerId: request.input.speakerId,
          speakerLabel,
          text: request.input.text,
        },
      },
      constraints: {
        mustNotReveal: STATIC_MUST_NOT_REVEAL,
        venueRestricted,
        outputLanguage: "zh-CN",
        historicalRegister: "明末朝堂语域",
      },
      trace: { saveId: request.saveId, revision: state.revision },
    };
  }
}
