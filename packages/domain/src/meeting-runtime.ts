import { z } from "zod";
import { JsonValueSchema } from "./state";

/**
 * 会议领域模型（Phase 4，ADR-015）。
 * 分层：
 * - GameState.meetings 仅保存最小投影（state.ts 的 MeetingRuntimeState，经 meeting.* 命令更新）；
 * - 本文件定义会议引擎的富运行态（MeetingSessionState，存 SQLite meeting_sessions，
 *   以 meetingVersion 乐观锁推进）、议程、参与者、回合、玩家动作、结果候选与泄密评估。
 * 红线：
 * - 会议发言不是世界事实；只有玩家批准且映射成功的候选才经 StateEngine 变更世界；
 * - 状态转换必须走 Meeting State Machine，不得任意赋值；
 * - 所有推进具备 meetingVersion / actionId / idempotencyKey，可恢复、可幂等。
 */

const IdSchema = z.string().trim().min(1);
const TextSchema = z.string().trim().min(1);
const NonNegativeInt = z.number().int().nonnegative();
const PositiveInt = z.number().int().positive();

/** 会议引擎支持的三类会议（GameState 侧另有 private-audience，属 Phase 3 单人召对） */
export const EngineMeetingTypeSchema = z.enum([
  "court-assembly",
  "imperial-council",
  "secret-council",
]);
export type EngineMeetingType = z.infer<typeof EngineMeetingTypeSchema>;

export const MeetingSessionStatusSchema = z.enum([
  "draft",
  "scheduled",
  "preparing",
  "in-progress",
  "waiting-for-player",
  "waiting-for-agent",
  "resolving",
  "paused",
  "concluded",
  "cancelled",
  "failed",
]);
export type MeetingSessionStatus = z.infer<typeof MeetingSessionStatusSchema>;

export const MeetingVisibilitySchema = z.enum(["court", "meeting", "private", "sealed"]);
export type MeetingVisibility = z.infer<typeof MeetingVisibilitySchema>;

/** 待玩家动作：Director 请求玩家输入时的上下文 */
export const PendingPlayerActionSchema = z
  .object({
    allowedActions: z.array(IdSchema).min(1),
    reason: TextSchema,
    requestedAtTurn: NonNegativeInt,
  })
  .strict();
export type PendingPlayerAction = z.infer<typeof PendingPlayerActionSchema>;

/** 待 Agent 回合：两阶段提交的阶段 A 预留（ADR-020） */
export const PendingAgentActionSchema = z
  .object({
    actionId: IdSchema,
    characterId: IdSchema,
    responseMode: z.enum(["speech", "answer", "rebuttal", "warning"]),
    addressedCharacterIds: z.array(IdSchema),
    reservedAtTurn: NonNegativeInt,
    reservedAt: z.iso.datetime(),
  })
  .strict();
export type PendingAgentAction = z.infer<typeof PendingAgentActionSchema>;

/** 会议上限配置（§9.3 防无限对话） */
export const MeetingLimitsSchema = z
  .object({
    maxTurns: PositiveInt,
    maxTurnsPerAgenda: PositiveInt,
    maxConsecutiveTurnsPerCharacter: PositiveInt,
    maxTurnsPerCharacter: PositiveInt,
    maxConsecutiveAgentTurns: PositiveInt,
    maxConsecutiveRebuttals: PositiveInt,
  })
  .strict();
export type MeetingLimits = z.infer<typeof MeetingLimitsSchema>;

export const DEFAULT_MEETING_LIMITS: MeetingLimits = {
  maxTurns: 60,
  maxTurnsPerAgenda: 24,
  maxConsecutiveTurnsPerCharacter: 2,
  maxTurnsPerCharacter: 10,
  maxConsecutiveAgentTurns: 6,
  maxConsecutiveRebuttals: 3,
};

/** 会议富运行态（SQLite meeting_sessions；GameState 只留最小投影） */
export const MeetingSessionStateSchema = z
  .object({
    meetingId: IdSchema,
    saveId: IdSchema,
    type: EngineMeetingTypeSchema,
    status: MeetingSessionStatusSchema,
    title: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    createdAtRevision: NonNegativeInt,
    startedAtRevision: NonNegativeInt.optional(),
    concludedAtRevision: NonNegativeInt.optional(),
    /** 乐观锁：每次会议内部推进 +1；stale 提交返回 MEETING_VERSION_STALE */
    meetingVersion: NonNegativeInt,
    turnNumber: NonNegativeInt,
    participantIds: z.array(IdSchema).min(1),
    chairCharacterId: IdSchema,
    agendaItemIds: z.array(IdSchema),
    currentAgendaItemId: IdSchema.optional(),
    currentSpeakerId: IdSchema.optional(),
    pendingPlayerAction: PendingPlayerActionSchema.optional(),
    pendingAgentAction: PendingAgentActionSchema.optional(),
    limits: MeetingLimitsSchema,
    usedTurns: NonNegativeInt,
    visibility: MeetingVisibilitySchema,
    outcomeCandidateIds: z.array(IdSchema),
    pauseReason: TextSchema.optional(),
    failureCode: IdSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type MeetingSessionState = z.infer<typeof MeetingSessionStateSchema>;

export const MeetingSessionRoleSchema = z.enum([
  "chair",
  "principal",
  "advisor",
  "minister",
  "observer",
  "recorder",
]);
export type MeetingSessionRole = z.infer<typeof MeetingSessionRoleSchema>;

export const MeetingAttendanceSchema = z.enum([
  "invited",
  "present",
  "absent",
  "dismissed",
  "removed",
]);
export type MeetingAttendance = z.infer<typeof MeetingAttendanceSchema>;

export const SpeakingRightsSchema = z.enum([
  "normal",
  "by-permission",
  "observer-only",
  "silenced",
]);
export type SpeakingRights = z.infer<typeof SpeakingRightsSchema>;

export const MeetingParticipantStateSchema = z
  .object({
    meetingId: IdSchema,
    characterId: IdSchema,
    role: MeetingSessionRoleSchema,
    attendance: MeetingAttendanceSchema,
    speakingRights: SpeakingRightsSchema,
    turnsSpoken: NonNegativeInt,
    lastSpokeAtTurn: NonNegativeInt.optional(),
    requestedToSpeak: z.boolean(),
    /** 被点名后的一次性临时发言权（by-permission 参与者用） */
    grantedByEmperorAtTurn: NonNegativeInt.optional(),
    challengedCharacterIds: z.array(IdSchema),
    /** 参与者离场/移出后可见性截止回合（信息隔离用） */
    visibleUntilTurn: NonNegativeInt.optional(),
    runtimeFlags: z.array(IdSchema),
  })
  .strict();
export type MeetingParticipantState = z.infer<typeof MeetingParticipantStateSchema>;

export const AgendaItemStatusSchema = z.enum([
  "queued",
  "open",
  "discussing",
  "decision-pending",
  "resolved",
  "deferred",
  "rejected",
  "cancelled",
]);
export type AgendaItemStatus = z.infer<typeof AgendaItemStatusSchema>;

export const MeetingAgendaItemSchema = z
  .object({
    agendaItemId: IdSchema,
    meetingId: IdSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    topicIds: z.array(IdSchema),
    proposerId: IdSchema,
    status: AgendaItemStatusSchema,
    priority: z.number().int().min(0).max(100),
    sequence: NonNegativeInt,
    maxTurns: PositiveInt,
    usedTurns: NonNegativeInt,
    relatedEntityIds: z.array(IdSchema),
    requiredOfficeIds: z.array(IdSchema),
    visibility: MeetingVisibilitySchema,
  })
  .strict();
export type MeetingAgendaItem = z.infer<typeof MeetingAgendaItemSchema>;

export const MeetingTurnTypeSchema = z.enum([
  "opening",
  "player-statement",
  "player-question",
  "request-to-speak",
  "character-speech",
  "character-answer",
  "character-rebuttal",
  "character-warning",
  "chair-intervention",
  "player-interruption",
  "player-ruling",
  "agenda-transition",
  "adjournment",
]);
export type MeetingTurnType = z.infer<typeof MeetingTurnTypeSchema>;

export const MeetingTurnRecordSchema = z
  .object({
    turnId: IdSchema,
    meetingId: IdSchema,
    saveId: IdSchema,
    agendaItemId: IdSchema.optional(),
    turnNumber: NonNegativeInt,
    type: MeetingTurnTypeSchema,
    speakerId: IdSchema,
    addressedCharacterIds: z.array(IdSchema),
    publicText: z.string().min(1).max(8_000),
    /** 私密元数据（如立场注记）；绝不含 internalAssessment 全文与系统 Prompt */
    privateMetadata: z.record(z.string(), JsonValueSchema).optional(),
    visibility: MeetingVisibilitySchema,
    stateRevision: NonNegativeInt,
    meetingVersion: NonNegativeInt,
    /** 幂等锚点：两阶段提交的 actionId（阶段 B 用它拒绝重复写入） */
    actionId: IdSchema.optional(),
    sourceTurnIds: z.array(IdSchema),
    promptVersions: z.record(z.string(), z.string().min(1)).optional(),
    providerTrace: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        durationMs: z.number().nonnegative(),
        repaired: z.boolean(),
      })
      .strict()
      .optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MeetingTurnRecord = z.infer<typeof MeetingTurnRecordSchema>;

/** 玩家会议动作（§10；自由文本限长，一律作为数据注入） */
const PlayerText = z.string().trim().min(1).max(2_000);
export const MeetingPlayerActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("address-meeting"), text: PlayerText }).strict(),
  z
    .object({ type: z.literal("ask-character"), characterId: IdSchema, text: PlayerText })
    .strict(),
  z.object({ type: z.literal("ask-open-question"), text: PlayerText }).strict(),
  z.object({ type: z.literal("grant-speaking-right"), characterId: IdSchema }).strict(),
  z.object({ type: z.literal("deny-speaking-right"), characterId: IdSchema }).strict(),
  z
    .object({
      type: z.literal("interrupt-character"),
      characterId: IdSchema,
      text: PlayerText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("request-rebuttal"),
      characterId: IdSchema,
      targetCharacterId: IdSchema,
    })
    .strict(),
  z.object({ type: z.literal("open-next-agenda") }).strict(),
  z
    .object({
      type: z.literal("defer-agenda"),
      agendaItemId: IdSchema,
      reason: PlayerText.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("issue-ruling"),
      agendaItemId: IdSchema,
      selectedOutcomeCandidateIds: z.array(IdSchema),
      text: PlayerText.optional(),
    })
    .strict(),
  z.object({ type: z.literal("pause-meeting"), reason: PlayerText.optional() }).strict(),
  z.object({ type: z.literal("conclude-meeting") }).strict(),
]);
export type MeetingPlayerAction = z.infer<typeof MeetingPlayerActionSchema>;
export type MeetingPlayerActionType = MeetingPlayerAction["type"];

/** 状态机事件（§7） */
export const MeetingStateEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("meeting.schedule") }).strict(),
  z.object({ type: z.literal("meeting.start-preparation") }).strict(),
  z.object({ type: z.literal("meeting.start") }).strict(),
  z.object({ type: z.literal("meeting.pause"), reason: TextSchema }).strict(),
  z.object({ type: z.literal("meeting.resume") }).strict(),
  z
    .object({ type: z.literal("meeting.await-player"), action: PendingPlayerActionSchema })
    .strict(),
  z.object({ type: z.literal("meeting.await-agent"), characterId: IdSchema }).strict(),
  z.object({ type: z.literal("meeting.agent-completed"), characterId: IdSchema }).strict(),
  z.object({ type: z.literal("meeting.open-agenda"), agendaItemId: IdSchema }).strict(),
  z.object({ type: z.literal("meeting.begin-resolution"), agendaItemId: IdSchema }).strict(),
  z.object({ type: z.literal("meeting.resolve-agenda"), agendaItemId: IdSchema }).strict(),
  z.object({ type: z.literal("meeting.step-completed") }).strict(),
  z.object({ type: z.literal("meeting.conclude") }).strict(),
  z.object({ type: z.literal("meeting.cancel"), reason: TextSchema }).strict(),
  z.object({ type: z.literal("meeting.fail"), errorCode: IdSchema }).strict(),
]);
export type MeetingStateEvent = z.infer<typeof MeetingStateEventSchema>;

export const OutcomeCandidateTypeSchema = z.enum([
  "policy-proposal",
  "appointment-proposal",
  "dismissal-proposal",
  "investigation-request",
  "resource-allocation-request",
  "military-order-proposal",
  "information-request",
  "agenda-deferral",
  "no-action",
]);
export type OutcomeCandidateType = z.infer<typeof OutcomeCandidateTypeSchema>;

export const OutcomeCandidateStatusSchema = z.enum([
  "draft",
  "presented",
  "accepted",
  "rejected",
  "deferred",
  "expired",
]);
export type OutcomeCandidateStatus = z.infer<typeof OutcomeCandidateStatusSchema>;

export const MeetingOutcomeCandidateSchema = z
  .object({
    outcomeCandidateId: IdSchema,
    meetingId: IdSchema,
    saveId: IdSchema,
    agendaItemId: IdSchema,
    type: OutcomeCandidateTypeSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    proposerIds: z.array(IdSchema),
    supporterIds: z.array(IdSchema),
    opponentIds: z.array(IdSchema),
    rationale: z.array(TextSchema),
    risks: z.array(TextSchema),
    sourceTurnIds: z.array(IdSchema).min(1),
    status: OutcomeCandidateStatusSchema,
    /** 候选命令预览：仅白名单类型可被 OutcomeCommandMapper 映射（ADR-019） */
    commandPreview: z
      .object({
        commandType: IdSchema,
        payload: z.record(z.string(), JsonValueSchema),
      })
      .strict()
      .optional(),
    /** 无法映射为命令时的标记 */
    unsupportedCommand: z.boolean(),
    createdAtRevision: NonNegativeInt,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MeetingOutcomeCandidate = z.infer<typeof MeetingOutcomeCandidateSchema>;

export const LeakRiskLevelSchema = z.enum(["minimal", "low", "moderate", "high", "critical"]);
export type LeakRiskLevel = z.infer<typeof LeakRiskLevelSchema>;

export const MeetingLeakAssessmentSchema = z
  .object({
    meetingId: IdSchema,
    saveId: IdSchema,
    riskScore: z.number().int().min(0).max(100),
    riskLevel: LeakRiskLevelSchema,
    contributingFactors: z.array(TextSchema),
    deterministicRoll: z
      .object({
        seedCursorBefore: NonNegativeInt,
        roll: z.number().min(0).max(1),
        threshold: z.number().min(0).max(1),
        triggered: z.boolean(),
      })
      .strict()
      .optional(),
    potentialAudienceIds: z.array(IdSchema),
    createdAtRevision: NonNegativeInt,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MeetingLeakAssessment = z.infer<typeof MeetingLeakAssessmentSchema>;

/** 会议纪要（§15）：正式/私密两层，逐项引用 sourceTurnIds，不新增事实 */
export const MeetingMinutesEntrySchema = z
  .object({
    text: TextSchema,
    sourceTurnIds: z.array(IdSchema).min(1),
  })
  .strict();
export type MeetingMinutesEntry = z.infer<typeof MeetingMinutesEntrySchema>;

export const MeetingMinutesSchema = z
  .object({
    minutesId: IdSchema,
    meetingId: IdSchema,
    saveId: IdSchema,
    kind: z.enum(["official", "private"]),
    /** private 层的授权角色（official 层为空 = 参与者共同知识） */
    audienceCharacterIds: z.array(IdSchema),
    title: TextSchema,
    participantIds: z.array(IdSchema),
    entries: z.array(MeetingMinutesEntrySchema),
    acceptedOutcomeCandidateIds: z.array(IdSchema),
    deferredAgendaItemIds: z.array(IdSchema),
    stateRevision: NonNegativeInt,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type MeetingMinutes = z.infer<typeof MeetingMinutesSchema>;

/** 会议 Transcript 注入预算（§11.1） */
export const MeetingContextBudgetSchema = z
  .object({
    maxRecentTurns: PositiveInt,
    maxRelevantTurns: PositiveInt,
    maxTranscriptCharacters: PositiveInt,
    maxEstimatedTokens: PositiveInt,
  })
  .strict();
export type MeetingContextBudget = z.infer<typeof MeetingContextBudgetSchema>;

export const DEFAULT_MEETING_CONTEXT_BUDGET: MeetingContextBudget = {
  maxRecentTurns: 8,
  maxRelevantTurns: 6,
  maxTranscriptCharacters: 6_000,
  maxEstimatedTokens: 3_000,
};
