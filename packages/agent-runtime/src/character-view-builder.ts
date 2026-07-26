import {
  CharacterStateViewSchema,
  type CharacterConversationMode,
  type CharacterKnowledgeItem,
  type CharacterMemory,
  type CharacterMemoryView,
  type CharacterStateView,
  type CharacterTemplate,
  type CharacterUncertainty,
  type GameState,
  type Institution,
  type Office,
} from "@mandate/domain";
import { CharacterAgentError } from "./errors";
import {
  coarsenValue,
  effectiveAccessLevel,
  resolveAccessContext,
  resolveCountryFigure,
  resolveKnownCharacter,
  resolveKnownMeeting,
  resolveKnownPolicy,
  type AccessContext,
  type KnowledgeDomain,
} from "./visibility-policy";

/**
 * Character View Builder（ADR-011）。
 * 确定性纯函数：从统一 GameState 构建某一角色的有限知识视图。
 * 红线：
 * - 绝不读取 state.hidden / state.flags 中的任何内容；
 * - 不返回其他角色的 favor / loyaltyToEmperor / stress / 私密记忆；
 * - 输出经 CharacterStateViewSchema strict 校验，多余字段直接报错。
 */

export interface CharacterViewAuthorization {
  /** 仅调试用途：允许把 sealed 记忆投影进视图（默认 false，普通链路不得开启） */
  readonly includeSealedMemories?: boolean;
}

export interface BuildCharacterViewInput {
  readonly state: GameState;
  readonly characterId: string;
  readonly context: {
    readonly mode: CharacterConversationMode;
    readonly participantIds?: readonly string[];
    readonly topicIds?: readonly string[];
    readonly currentMeetingId?: string;
  };
  readonly memories: readonly CharacterMemory[];
  readonly templates: {
    readonly characters: readonly CharacterTemplate[];
    readonly offices: readonly Office[];
    readonly institutions: readonly Institution[];
  };
  readonly authorization?: CharacterViewAuthorization;
}

/** 感知类数值（合法性/稳定）：不是官员案头的数字，而是身处朝局的体感 */
function resolvePerceptionFigure(
  context: AccessContext,
  domain: KnowledgeDomain,
  value: number,
): CharacterKnowledgeItem<number> | undefined {
  const level = effectiveAccessLevel(context, domain);
  if (level === "none") return undefined;
  if (!context.isActive) {
    return {
      value: coarsenValue(value, 10),
      status: "outdated",
      confidence: 25,
      sourceType: "personal",
      sourceIds: [],
    };
  }
  return {
    value: coarsenValue(value, 5),
    status: "inferred",
    confidence: level === "privileged" ? 65 : 50,
    sourceType: "inference",
    sourceIds: [],
  };
}

function projectMemory(memory: CharacterMemory): CharacterMemoryView {
  return {
    memoryId: memory.memoryId,
    type: memory.type,
    content: memory.content,
    confidence: memory.confidence,
    importance: memory.importance,
    status: memory.status,
    sourceRevision: memory.sourceRevision,
    topicTags: [...memory.topicTags],
  };
}

export function buildCharacterView(input: BuildCharacterViewInput): CharacterStateView {
  const { state, characterId, templates } = input;
  const template = templates.characters.find((value) => value.id === characterId);
  if (!template || !state.characters[characterId]) {
    throw new CharacterAgentError("CHARACTER_NOT_FOUND", `人物不存在：${characterId}`);
  }

  let context: AccessContext;
  try {
    context = resolveAccessContext(state, template, templates.offices, templates.institutions);
  } catch (error) {
    throw new CharacterAgentError(
      "CHARACTER_VIEW_BUILD_FAILED",
      `角色视图构建失败：${characterId}`,
      error,
    );
  }
  const self = context.selfRuntime;
  const countrySourceIds = state.country.sourceIds;

  const knownCountryState: CharacterStateView["knownCountryState"] = {};
  const treasury = resolveCountryFigure(context, state, "state-finance", state.country.treasuryTaels, {
    coarseGranularity: 500_000,
    sourceIds: countrySourceIds,
  });
  if (treasury) knownCountryState.treasuryTaels = treasury;
  const grain = resolveCountryFigure(context, state, "state-finance", state.country.grainReserveShi, {
    coarseGranularity: 500_000,
    sourceIds: countrySourceIds,
  });
  if (grain) knownCountryState.grainReserveShi = grain;
  const readiness = resolveCountryFigure(
    context,
    state,
    "military",
    state.country.militaryReadiness,
    { coarseGranularity: 10, sourceIds: countrySourceIds },
  );
  if (readiness) knownCountryState.militaryReadiness = readiness;
  const adminCapacity = resolveCountryFigure(
    context,
    state,
    "court-politics",
    state.country.administrativeCapacity,
    { coarseGranularity: 10, sourceIds: countrySourceIds },
  );
  if (adminCapacity) knownCountryState.administrativeCapacity = adminCapacity;
  const legitimacy = resolvePerceptionFigure(context, "court-politics", state.country.legitimacy);
  if (legitimacy) knownCountryState.legitimacy = legitimacy;
  const stability = resolvePerceptionFigure(context, "court-politics", state.country.stability);
  if (stability) knownCountryState.stability = stability;

  const templateNames = new Map(templates.characters.map((value) => [value.id, value.name]));
  const knownCharacters = Object.values(state.characters)
    .filter((target) => target.characterId !== characterId)
    .map((target) => {
      const name = templateNames.get(target.characterId);
      return name ? resolveKnownCharacter(context, target, name) : undefined;
    })
    .filter((value) => value !== undefined)
    .sort((a, b) => a.value.characterId.localeCompare(b.value.characterId));

  const knownPolicies = Object.values(state.policies)
    .map((policy) => resolveKnownPolicy(context, policy))
    .filter((value) => value !== undefined)
    .sort((a, b) => a.value.policyId.localeCompare(b.value.policyId));

  const knownEvents = [...state.eventQueue.processedEventIds]
    .sort((a, b) => a.localeCompare(b))
    .map((eventId) => ({
      value: { eventId },
      status: (context.isActive ? "known" : "reported") as "known" | "reported",
      confidence: context.isActive ? 80 : 50,
      sourceType: "official" as const,
      sourceIds: [] as string[],
    }));

  const knownMeetings = Object.values(state.meetings)
    .map((meeting) => resolveKnownMeeting(context, meeting))
    .filter((value) => value !== undefined)
    .sort((a, b) => a.value.meetingId.localeCompare(b.value.meetingId));

  const includeSealed = input.authorization?.includeSealedMemories === true;
  const relevantMemories = input.memories
    .filter(
      (memory) =>
        memory.characterId === characterId &&
        memory.saveId === state.saveId &&
        memory.status !== "forgotten" &&
        (includeSealed || memory.visibility !== "sealed"),
    )
    .map(projectMemory);

  const uncertainties: CharacterUncertainty[] = [];
  const financeLevel = effectiveAccessLevel(context, "state-finance");
  if (financeLevel === "none" || financeLevel === "limited") {
    uncertainties.push({
      topic: "国库度支",
      reason: financeLevel === "none" ? "非度支职掌，无从得知实数" : "非户部案牍，所知仅为粗数",
    });
  }
  const militaryLevel = effectiveAccessLevel(context, "military");
  if (militaryLevel === "none" || militaryLevel === "limited") {
    uncertainties.push({
      topic: "军镇实情",
      reason: militaryLevel === "none" ? "不预兵事，所闻皆市井传言" : "塘报不全，军前实情有滞后",
    });
  }
  if (!context.isActive) {
    uncertainties.push({ topic: "朝局近况", reason: "去职在籍，消息滞后旬月" });
  }

  const view: CharacterStateView = {
    character: {
      id: template.id,
      name: template.name,
      currentOfficeId: self.officeId,
      runtimeStatus: self.status,
    },
    currentDate: state.currentDate,
    revision: state.revision,
    selfState: {
      characterId: self.characterId,
      status: self.status,
      officeId: self.officeId,
      loyaltyToEmperor: self.loyaltyToEmperor,
      stress: self.stress,
      perceivedFavor: {
        value: coarsenValue(self.favor, 10),
        status: "inferred",
        confidence: 50,
        sourceType: "inference",
        sourceIds: [],
      },
    },
    knownCountryState,
    knownCharacters,
    knownPolicies,
    knownEvents,
    knownMeetings,
    activeContext: {
      mode: input.context.mode,
      participantIds: [...(input.context.participantIds ?? [])],
      topicIds: [...(input.context.topicIds ?? [])],
      ...(input.context.currentMeetingId === undefined
        ? {}
        : { currentMeetingId: input.context.currentMeetingId }),
    },
    relevantMemories,
    uncertainties,
  };

  const result = CharacterStateViewSchema.safeParse(view);
  if (!result.success) {
    throw new CharacterAgentError(
      "CHARACTER_VIEW_BUILD_FAILED",
      `角色视图未通过 Schema 校验：${characterId}`,
      result.error.issues,
    );
  }
  return structuredClone(result.data);
}
