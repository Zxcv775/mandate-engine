import { z } from "zod";
import { ApiResponseMetaSchema } from "./api";
import {
  CharacterConversationModeSchema,
  CharacterPublicResponseSchema,
} from "./character-agent";
import {
  CharacterMemoryTypeSchema,
  MemoryStatusSchema,
} from "./character-memory";
import { CharacterRuntimeStatusSchema } from "./state";

/**
 * 人物交互 API 契约（Phase 3）。
 * 红线：
 * - 玩家 API 只返回公开投影：不含 internalAssessment、私密记忆、hidden state、
 *   人格/能力数值全集与私人目标；
 * - respond 不提交任何 GameState 变更；
 * - Debug API 生产环境默认禁用。
 */

const IdSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_.:-]+$/);

export const CharacterIdParamsSchema = z
  .object({ saveId: IdSchema, characterId: IdSchema })
  .strict();

/** 人物列表条目：运行时公开摘要 */
export const CharacterSummarySchema = z
  .object({
    characterId: IdSchema,
    name: z.string().trim().min(1),
    currentOfficeId: IdSchema.nullable(),
    status: CharacterRuntimeStatusSchema,
    /** 当前是否可被召对（active 且在朝任职） */
    availableForAudience: z.boolean(),
    /** 公开身份标签（派系等玩家可见信息），非内部数值 */
    publicTags: z.array(z.string().trim().min(1)),
  })
  .strict();
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

export const CharacterListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.array(CharacterSummarySchema),
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type CharacterListResponse = z.infer<typeof CharacterListResponseSchema>;

/** 人物公开档案：玩家可见的历史公开信息 + 当前公开状态 */
export const CharacterPublicProfileSchema = z
  .object({
    characterId: IdSchema,
    name: z.string().trim().min(1),
    courtesyName: z.string().trim().min(1).optional(),
    aliases: z.array(z.string().trim().min(1)),
    birthYear: z.number().int().optional(),
    historicalSummary: z.string().trim().min(1),
    historicalReputation: z.array(z.string().trim().min(1)),
    publicPositions: z.array(z.string().trim().min(1)),
    factionIds: z.array(IdSchema),
    currentOfficeId: IdSchema.nullable(),
    status: CharacterRuntimeStatusSchema,
    availableForAudience: z.boolean(),
  })
  .strict();
export type CharacterPublicProfile = z.infer<typeof CharacterPublicProfileSchema>;

export const CharacterProfileResponseSchema = z
  .object({
    ok: z.literal(true),
    data: CharacterPublicProfileSchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type CharacterProfileResponse = z.infer<typeof CharacterProfileResponseSchema>;

export const CharacterRespondRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: CharacterConversationModeSchema,
    input: z
      .object({
        speakerId: IdSchema,
        text: z.string().trim().min(1).max(4_000),
      })
      .strict(),
    participantIds: z.array(IdSchema).max(50).optional(),
    topic: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CharacterRespondRequest = z.infer<typeof CharacterRespondRequestSchema>;

export const CharacterRespondResponseSchema = z
  .object({
    ok: z.literal(true),
    data: CharacterPublicResponseSchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type CharacterRespondResponse = z.infer<typeof CharacterRespondResponseSchema>;

/** Debug：人物记忆查询过滤参数（仅开发环境路由使用） */
export const CharacterMemoryQuerySchema = z
  .object({
    type: CharacterMemoryTypeSchema.optional(),
    status: MemoryStatusSchema.optional(),
    topic: IdSchema.optional(),
    relatedCharacterId: IdSchema.optional(),
    fromRevision: z.coerce.number().int().nonnegative().optional(),
    toRevision: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type CharacterMemoryQuery = z.infer<typeof CharacterMemoryQuerySchema>;
