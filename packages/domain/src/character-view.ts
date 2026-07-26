import { z } from "zod";
import { CharacterRuntimeStatusSchema } from "./state";
import { CharacterMemoryTypeSchema, MemoryStatusSchema } from "./character-memory";

/**
 * 角色有限知识视图（Phase 3，ADR-011）。
 * 红线：
 * - 角色不能读取完整 GameState；视图只包含其身份/官职/会议参与允许知道的信息；
 * - hidden / sealed / 其他角色私密数据（favor、loyaltyToEmperor、privateInterests、
 *   私密记忆）一律不得进入视图；
 * - 每条信息必须标注认知状态（KnowledgeStatus）、来源类型与可信度，
 *   区分事实 / 听闻 / 推测 / 过时 / 错误认知；错误认知不会被系统自动纠正。
 */

const IdSchema = z.string().trim().min(1);
const Score100Schema = z.number().int().min(0).max(100);

export const KnowledgeStatusSchema = z.enum([
  "known",
  "reported",
  "suspected",
  "inferred",
  "outdated",
  "contradicted",
  "unknown",
]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;

export const KnowledgeSourceTypeSchema = z.enum([
  "official",
  "personal",
  "meeting",
  "memorial",
  "intelligence",
  "rumor",
  "inference",
]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

/** 信息可见级别：Phase 3 统一裁决口径（ADR-011） */
export const InformationVisibilitySchema = z.enum([
  "public",
  "court",
  "office",
  "meeting",
  "private",
  "sealed",
]);
export type InformationVisibility = z.infer<typeof InformationVisibilitySchema>;

/** 生成带认知标注的知识条目 Schema */
export function characterKnowledgeItemSchema<TValue extends z.ZodType>(value: TValue) {
  return z
    .object({
      value,
      status: KnowledgeStatusSchema,
      confidence: Score100Schema,
      learnedAtRevision: z.number().int().nonnegative().optional(),
      lastConfirmedAtRevision: z.number().int().nonnegative().optional(),
      sourceType: KnowledgeSourceTypeSchema,
      sourceIds: z.array(IdSchema),
    })
    .strict();
}

export interface CharacterKnowledgeItem<TValue> {
  value: TValue;
  status: KnowledgeStatus;
  confidence: number;
  learnedAtRevision?: number;
  lastConfirmedAtRevision?: number;
  sourceType: KnowledgeSourceType;
  sourceIds: string[];
}

/** 自身状态：角色对自己的认知（favor 是皇帝的心证，只能感知不能确知） */
export const CharacterSelfViewSchema = z
  .object({
    characterId: IdSchema,
    status: CharacterRuntimeStatusSchema,
    officeId: IdSchema.nullable(),
    loyaltyToEmperor: Score100Schema,
    stress: Score100Schema,
    perceivedFavor: characterKnowledgeItemSchema(z.number().int().min(-100).max(100)),
  })
  .strict();
export type CharacterSelfView = z.infer<typeof CharacterSelfViewSchema>;

/** 国家状态认知：字段缺失 = 该角色对此一无所知 */
export const KnownCountryStateSchema = z
  .object({
    treasuryTaels: characterKnowledgeItemSchema(z.number().int().nonnegative()).optional(),
    grainReserveShi: characterKnowledgeItemSchema(z.number().int().nonnegative()).optional(),
    legitimacy: characterKnowledgeItemSchema(Score100Schema).optional(),
    stability: characterKnowledgeItemSchema(Score100Schema).optional(),
    administrativeCapacity: characterKnowledgeItemSchema(Score100Schema).optional(),
    militaryReadiness: characterKnowledgeItemSchema(Score100Schema).optional(),
  })
  .strict();
export type KnownCountryState = z.infer<typeof KnownCountryStateSchema>;

export const KnownCharacterViewSchema = characterKnowledgeItemSchema(
  z
    .object({
      characterId: IdSchema,
      name: z.string().trim().min(1),
      officeId: IdSchema.nullable(),
      status: CharacterRuntimeStatusSchema,
    })
    .strict(),
);
export type KnownCharacterView = z.infer<typeof KnownCharacterViewSchema>;

export const KnownPolicyViewSchema = characterKnowledgeItemSchema(
  z
    .object({
      policyId: IdSchema,
      status: z.string().trim().min(1),
      /** Phase 5：负责语义由官职改为具体人物；进度为玩家可见奏报口径 */
      responsibleCharacterIds: z.array(IdSchema),
      overallProgress: z.number().int().min(0).max(100),
    })
    .strict(),
);
export type KnownPolicyView = z.infer<typeof KnownPolicyViewSchema>;

export const KnownEventViewSchema = characterKnowledgeItemSchema(
  z
    .object({
      eventId: IdSchema,
    })
    .strict(),
);
export type KnownEventView = z.infer<typeof KnownEventViewSchema>;

export const KnownMeetingViewSchema = characterKnowledgeItemSchema(
  z
    .object({
      meetingId: IdSchema,
      type: z.string().trim().min(1),
      status: z.string().trim().min(1),
      /** 仅会议参与者可见参与人名单；非参与者的条目此数组为空 */
      participantIds: z.array(IdSchema),
    })
    .strict(),
);
export type KnownMeetingView = z.infer<typeof KnownMeetingViewSchema>;

export const CharacterConversationContextSchema = z
  .object({
    mode: z.enum([
      "private-audience",
      "court-assembly",
      "imperial-council",
      "secret-council",
      "memorial-response",
      "general",
    ]),
    participantIds: z.array(IdSchema),
    topicIds: z.array(IdSchema),
    currentMeetingId: IdSchema.optional(),
  })
  .strict();
export type CharacterConversationContext = z.infer<typeof CharacterConversationContextSchema>;

/** 注入视图的记忆投影：不含 saveId/结构化内部字段 */
export const CharacterMemoryViewSchema = z
  .object({
    memoryId: IdSchema,
    type: CharacterMemoryTypeSchema,
    content: z.string().trim().min(1),
    confidence: Score100Schema,
    importance: Score100Schema,
    status: MemoryStatusSchema,
    sourceRevision: z.number().int().nonnegative(),
    topicTags: z.array(IdSchema),
  })
  .strict();
export type CharacterMemoryView = z.infer<typeof CharacterMemoryViewSchema>;

export const CharacterUncertaintySchema = z
  .object({
    topic: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();
export type CharacterUncertainty = z.infer<typeof CharacterUncertaintySchema>;

/** 角色有限知识视图（Phase 3 主视图；替代 state.ts 中的最小占位视图） */
export const CharacterStateViewSchema = z
  .object({
    character: z
      .object({
        id: IdSchema,
        name: z.string().trim().min(1),
        currentOfficeId: IdSchema.nullable(),
        runtimeStatus: CharacterRuntimeStatusSchema,
      })
      .strict(),
    currentDate: z.iso.date(),
    revision: z.number().int().nonnegative(),
    selfState: CharacterSelfViewSchema,
    knownCountryState: KnownCountryStateSchema,
    knownCharacters: z.array(KnownCharacterViewSchema),
    knownPolicies: z.array(KnownPolicyViewSchema),
    knownEvents: z.array(KnownEventViewSchema),
    knownMeetings: z.array(KnownMeetingViewSchema),
    activeContext: CharacterConversationContextSchema,
    relevantMemories: z.array(CharacterMemoryViewSchema),
    uncertainties: z.array(CharacterUncertaintySchema),
  })
  .strict();
export type CharacterStateView = z.infer<typeof CharacterStateViewSchema>;
