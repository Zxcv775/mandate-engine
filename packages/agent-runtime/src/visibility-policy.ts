import type {
  CharacterKnowledgeItem,
  CharacterRuntimeState,
  CharacterTemplate,
  GameState,
  Institution,
  InstitutionType,
  KnowledgeAccessLevel,
  KnowledgeStatus,
  MeetingRuntimeState,
  Office,
  PolicyRuntimeState,
} from "@mandate/domain";

/**
 * 信息可见性策略（ADR-011）。
 * 全部为确定性纯函数：同一输入必得同一输出，可独立测试。
 * 原则：不是 removeHidden(state)——每一类信息都按
 * 「身份 + 官职机构 + 知识领域 + 会议参与 + 在朝与否」逐条裁决，
 * 并给出认知状态（known/reported/…）与可信度，而非简单的可见/不可见二值。
 */

/** 知识领域：与人物卡 knowledgeProfile.accessLevels 的 domain 值对齐 */
export type KnowledgeDomain =
  "state-finance" | "military" | "court-politics" | "palace" | "intelligence";

const ACCESS_ORDER: readonly KnowledgeAccessLevel[] = ["none", "limited", "normal", "privileged"];

function maxAccess(a: KnowledgeAccessLevel, b: KnowledgeAccessLevel): KnowledgeAccessLevel {
  return ACCESS_ORDER.indexOf(a) >= ACCESS_ORDER.indexOf(b) ? a : b;
}

function capAccess(level: KnowledgeAccessLevel, cap: KnowledgeAccessLevel): KnowledgeAccessLevel {
  return ACCESS_ORDER.indexOf(level) <= ACCESS_ORDER.indexOf(cap) ? level : cap;
}

/** 机构类型带来的领域访问加成（官职生效的前提是人物在任） */
const INSTITUTION_ACCESS: Readonly<
  Record<InstitutionType, Partial<Record<KnowledgeDomain, KnowledgeAccessLevel>>>
> = {
  decision: { "court-politics": "privileged", "state-finance": "normal", military: "normal" },
  administration: { "court-politics": "normal" },
  censorate: { "court-politics": "privileged" },
  military: { military: "privileged", "court-politics": "normal" },
  fiscal: { "state-finance": "privileged", "court-politics": "normal" },
  intelligence: { intelligence: "privileged", "court-politics": "normal" },
  palace: { palace: "privileged", "court-politics": "limited" },
  local: {},
};

export interface AccessContext {
  readonly template: CharacterTemplate;
  readonly selfRuntime: CharacterRuntimeState;
  /** 当前官职对应的机构（无官职或查不到则为 undefined） */
  readonly institution: Institution | undefined;
  /** 是否在朝：active 且视图裁决按此降级 */
  readonly isActive: boolean;
}

export function resolveAccessContext(
  state: GameState,
  template: CharacterTemplate,
  offices: readonly Office[],
  institutions: readonly Institution[],
): AccessContext {
  const selfRuntime = state.characters[template.id];
  if (!selfRuntime) {
    throw new Error(`角色 "${template.id}" 不在 GameState 中`);
  }
  const office = selfRuntime.officeId
    ? offices.find((value) => value.id === selfRuntime.officeId)
    : undefined;
  const institution = office
    ? institutions.find((value) => value.id === office.institutionId)
    : undefined;
  return {
    template,
    selfRuntime,
    institution,
    isActive: selfRuntime.status === "active",
  };
}

/**
 * 领域访问级别 = max(人物卡 accessLevels, 在任机构加成)；
 * 非在朝人物（去职/流放/监禁）一律封顶 limited——旧知识仍在，但已失体制内渠道。
 */
export function effectiveAccessLevel(
  context: AccessContext,
  domain: KnowledgeDomain,
): KnowledgeAccessLevel {
  const declared =
    context.template.knowledgeProfile.accessLevels.find((entry) => entry.domain === domain)
      ?.level ?? "none";
  const institutional = context.isActive
    ? context.institution
      ? (INSTITUTION_ACCESS[context.institution.type][domain] ?? "none")
      : "none"
    : "none";
  // 身在朝中之人对朝局至少有体感（limited 下限），无须任何官职
  const activeFloor: KnowledgeAccessLevel =
    context.isActive && domain === "court-politics" ? "limited" : "none";
  const combined = maxAccess(maxAccess(declared, institutional), activeFloor);
  return context.isActive ? combined : capAccess(combined, "limited");
}

function knowledgeItem<T>(
  value: T,
  status: KnowledgeStatus,
  confidence: number,
  sourceType: CharacterKnowledgeItem<T>["sourceType"],
  sourceIds: readonly string[],
  learnedAtRevision?: number,
): CharacterKnowledgeItem<T> {
  return {
    value,
    status,
    confidence,
    sourceType,
    sourceIds: [...sourceIds],
    ...(learnedAtRevision === undefined ? {} : { learnedAtRevision }),
  };
}

/** 把精确数值粗化为传闻级别的约数（去职者与低权限者只应知道大概） */
export function coarsenValue(value: number, granularity: number): number {
  return Math.round(value / granularity) * granularity;
}

/**
 * 国家数值的可见性裁决。
 * 返回 undefined = 该角色对此完全未知（视图中省略该字段）。
 */
export function resolveCountryFigure(
  context: AccessContext,
  state: GameState,
  domain: KnowledgeDomain,
  value: number,
  options: { coarseGranularity: number; sourceIds: readonly string[] },
): CharacterKnowledgeItem<number> | undefined {
  const level = effectiveAccessLevel(context, domain);
  if (level === "none") return undefined;
  if (!context.isActive) {
    // 去职在籍：只剩过时的粗略印象
    return knowledgeItem(
      coarsenValue(value, options.coarseGranularity),
      "outdated",
      30,
      "personal",
      options.sourceIds,
    );
  }
  if (level === "privileged") {
    return knowledgeItem(value, "known", 95, "official", options.sourceIds, state.revision);
  }
  if (level === "normal") {
    return knowledgeItem(value, "known", 75, "official", options.sourceIds, state.revision);
  }
  return knowledgeItem(
    coarsenValue(value, options.coarseGranularity),
    "reported",
    45,
    "rumor",
    options.sourceIds,
  );
}

/** 其他人物的公开状态：在朝者为公开事实；非在朝观察者只有滞后传闻 */
export function resolveKnownCharacter(
  context: AccessContext,
  target: CharacterRuntimeState,
  targetName: string,
): CharacterKnowledgeItem<{
  characterId: string;
  name: string;
  officeId: string | null;
  status: CharacterRuntimeState["status"];
}> {
  const value = {
    characterId: target.characterId,
    name: targetName,
    officeId: target.officeId,
    status: target.status,
  };
  return context.isActive
    ? knowledgeItem(value, "known", 90, "official", [])
    : knowledgeItem(value, "reported", 55, "rumor", []);
}

/**
 * 政策可见性（Phase 5 生命周期）：
 * 草案/待批只对负责人可见；颁行后为朝廷公开信息；
 * 公开值只含玩家可见快照（进度为奏报口径），hidden 真实值不入任何角色视图。
 */
export function resolveKnownPolicy(
  context: AccessContext,
  policy: PolicyRuntimeState,
):
  | CharacterKnowledgeItem<{
      policyId: string;
      status: string;
      responsibleCharacterIds: string[];
      overallProgress: number;
    }>
  | undefined {
  const value = {
    policyId: policy.policyId,
    status: policy.status,
    responsibleCharacterIds: [...policy.responsibleCharacterIds],
    overallProgress: policy.overallProgress,
  };
  const isResponsible = policy.responsibleCharacterIds.includes(context.selfRuntime.characterId);
  if (policy.status === "draft" || policy.status === "proposed") {
    return isResponsible
      ? knowledgeItem(value, "known", 80, "official", policy.sourceIds)
      : undefined;
  }
  if (!context.isActive) {
    return knowledgeItem(value, "reported", 50, "rumor", policy.sourceIds);
  }
  return knowledgeItem(value, "known", 85, "official", policy.sourceIds);
}

/**
 * 会议可见性：
 * - 参与者：完整可见（meeting 级信息）；
 * - 朝会（court-assembly）：公开事件，众所周知；
 * - 御前会议：非参与者仅知"曾有召对"之传闻，且不泄露与会名单；
 * - 秘密议事 / 单独召见：非参与者完全不可见（连存在都不暴露）。
 */
export function resolveKnownMeeting(
  context: AccessContext,
  meeting: MeetingRuntimeState,
):
  | CharacterKnowledgeItem<{
      meetingId: string;
      type: string;
      status: string;
      participantIds: string[];
    }>
  | undefined {
  const isParticipant = meeting.participantIds.includes(context.template.id);
  if (isParticipant) {
    return knowledgeItem(
      {
        meetingId: meeting.meetingId,
        type: meeting.type,
        status: meeting.status,
        participantIds: [...meeting.participantIds],
      },
      "known",
      95,
      "meeting",
      meeting.sourceIds,
    );
  }
  if (meeting.type === "court-assembly") {
    return knowledgeItem(
      {
        meetingId: meeting.meetingId,
        type: meeting.type,
        status: meeting.status,
        participantIds: [...meeting.participantIds],
      },
      context.isActive ? "known" : "reported",
      context.isActive ? 80 : 50,
      "official",
      meeting.sourceIds,
    );
  }
  if (meeting.type === "imperial-council" && context.isActive) {
    return knowledgeItem(
      {
        meetingId: meeting.meetingId,
        type: meeting.type,
        status: meeting.status,
        participantIds: [],
      },
      "reported",
      40,
      "rumor",
      [],
    );
  }
  // secret-council / private-audience：非参与者不可见
  return undefined;
}
