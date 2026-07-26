import { z } from "zod";
import { JsonValueSchema } from "./state";

/**
 * 人物记忆（Phase 3，ADR-012）。
 * 红线：
 * - 记忆不是客观真相：只代表"角色记住了什么、来源与可信度"；
 * - 记忆独立于 GameState 与 StateChangeLog，写入不产生世界状态变更；
 * - Character Agent 不得直接持久化记忆：只能产出 memoryCandidates，
 *   经 Schema 校验 → Memory Policy → Application Service 批准后落库；
 * - 本阶段不使用向量数据库，选择/排序采用确定性规则评分。
 */

const IdSchema = z.string().trim().min(1);
/** 0-100 整数：可信度 / 重要度 */
const Score100Schema = z.number().int().min(0).max(100);

/** 单条记忆内容的最大长度（字符），超出即拒绝，防止把整段对话原文塞进记忆 */
export const MEMORY_CONTENT_MAX_LENGTH = 500;

export const CharacterMemoryTypeSchema = z.enum([
  "episodic",
  "semantic",
  "relationship",
  "belief",
  "commitment",
  "suspicion",
  "instruction",
  "summary",
]);
export type CharacterMemoryType = z.infer<typeof CharacterMemoryTypeSchema>;

export const MemorySourceTypeSchema = z.enum([
  "observed",
  "told",
  "official-record",
  "rumor",
  "inference",
  "agent-generated-summary",
]);
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;

export const MemoryVisibilitySchema = z.enum(["self", "private", "shareable", "sealed"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const MemoryStatusSchema = z.enum(["active", "outdated", "contradicted", "forgotten"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const CharacterMemorySchema = z
  .object({
    memoryId: IdSchema,
    saveId: IdSchema,
    characterId: IdSchema,
    type: CharacterMemoryTypeSchema,
    content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX_LENGTH),
    structuredContent: z.record(z.string(), JsonValueSchema).optional(),
    relatedCharacterIds: z.array(IdSchema),
    relatedEntityIds: z.array(IdSchema),
    topicTags: z.array(IdSchema),
    /** 该记忆形成时对应的 GameState revision（信息时效锚点） */
    sourceRevision: z.number().int().nonnegative(),
    sourceTxId: IdSchema.optional(),
    sourceMeetingId: IdSchema.optional(),
    sourceCommandId: IdSchema.optional(),
    sourceType: MemorySourceTypeSchema,
    confidence: Score100Schema,
    importance: Score100Schema,
    visibility: MemoryVisibilitySchema,
    status: MemoryStatusSchema,
    createdAt: z.iso.datetime(),
    lastRecalledAt: z.iso.datetime().optional(),
    recallCount: z.number().int().nonnegative(),
  })
  .strict();
export type CharacterMemory = z.infer<typeof CharacterMemorySchema>;

/**
 * Agent 产出的记忆候选：无 id/saveId/时间戳等系统字段，
 * 由 Memory Policy 审批后再补全落库；候选必须可被拒绝。
 */
export const CharacterMemoryCandidateSchema = z
  .object({
    type: CharacterMemoryTypeSchema,
    content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX_LENGTH),
    structuredContent: z.record(z.string(), JsonValueSchema).optional(),
    relatedCharacterIds: z.array(IdSchema),
    relatedEntityIds: z.array(IdSchema),
    topicTags: z.array(IdSchema),
    sourceType: MemorySourceTypeSchema,
    confidence: Score100Schema,
    importance: Score100Schema,
    visibility: MemoryVisibilitySchema,
  })
  .strict();
export type CharacterMemoryCandidate = z.infer<typeof CharacterMemoryCandidateSchema>;

export const MemoryBudgetSchema = z
  .object({
    maxItems: z.number().int().positive(),
    maxCharacters: z.number().int().positive(),
    maxEstimatedTokens: z.number().int().positive(),
  })
  .strict();
export type MemoryBudget = z.infer<typeof MemoryBudgetSchema>;

/** 默认记忆预算（gameplay-adjusted 工程默认值，可配置覆盖） */
export const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
  maxItems: 12,
  maxCharacters: 4_000,
  maxEstimatedTokens: 2_000,
};

/** 记忆摘要结果：只压缩已有记忆，必须保留被压缩来源与 revision 范围 */
export const MemorySummarySchema = z
  .object({
    content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX_LENGTH),
    summarizedMemoryIds: z.array(IdSchema).min(1),
    sourceRevisionRange: z
      .object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
      })
      .strict(),
    /** 摘要中不确定信息的显式标注 */
    uncertaintyNotes: z.array(z.string().trim().min(1)),
  })
  .strict();
export type MemorySummary = z.infer<typeof MemorySummarySchema>;
