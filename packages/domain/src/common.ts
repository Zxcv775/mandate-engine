import { z } from "zod";

/**
 * 史料来源（HistoricalSource）。
 * 红线：一切历史模板数据必须经 meta.sourceIds 关联到来源（FR-HIST-001）。
 * 网络传说与文学演义不得作为 primary 来源（ADR-004）。
 */
export const HistoricalSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    author: z.string().trim().min(1).optional(),
    sourceType: z.enum(["primary", "academic", "reference", "inference"]),
    citation: z.string().trim().min(1).optional(),
    url: z.url().optional(),
    accessedAt: z.iso.date().optional(),
    reliability: z.enum(["high", "medium", "low", "disputed"]),
    notes: z.string().trim().min(1).optional(),
  })
  .strict();
export type HistoricalSource = z.infer<typeof HistoricalSourceSchema>;

/**
 * 数据确认状态：历史资料不足或存在争议时必须显式标注。
 * confirmed=已确认；disputed=存在争议；inferred=合理推测；gameplay-adjusted=为可玩性调整。
 */
export const DataConfirmationSchema = z.enum([
  "confirmed",
  "disputed",
  "inferred",
  "gameplay-adjusted",
]);
export type DataConfirmation = z.infer<typeof DataConfirmationSchema>;

/** 模板通用元数据：所有历史模板数据的必备标注 */
export const TemplateMetaSchema = z
  .object({
    sourceIds: z.array(z.string().trim().min(1)).min(1),
    confirmation: DataConfirmationSchema,
    notes: z.string().trim().min(1).optional(),
  })
  .strict();
export type TemplateMeta = z.infer<typeof TemplateMetaSchema>;

/** Modifier 运算类型 */
export const ModifierOperationSchema = z.enum(["add", "multiply", "set"]);
export type ModifierOperation = z.infer<typeof ModifierOperationSchema>;

/**
 * Modifier（修正器）：数据驱动规则的核心（ADR-003）。
 * 一切数值影响（政策/人物/制度/地区/事件）的统一表达；
 * LLM 不得直接生成生效的 Modifier——草案中的数值须经规则引擎换算确认。
 */
export const ModifierSchema = z
  .object({
  id: z.string().trim().min(1),
  /** 来源实体 ID（政策/人物/制度/事件），用于溯源与 ruleRefs */
  sourceId: z.string().trim().min(1),
  /** 状态路径，例如 "country.treasury"、"region:shaanxi.publicOrder" */
  targetPath: z.string().trim().min(1),
  operation: ModifierOperationSchema,
  value: z.number(),
  /** 生效回合数；缺省为一次性 */
  durationTurns: z.number().int().positive().optional(),
  /** 白名单条件 DSL 表达式（禁止 eval，见 ADR-003） */
  condition: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  })
  .strict();
export type Modifier = z.infer<typeof ModifierSchema>;

/** 标准化资源类型 */
export const ResourceTypeSchema = z.enum([
  "silver",
  "grain",
  "population",
  "manpower",
  "prestige",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

/** 资源值对象（随宿主实体归属） */
export interface Resource {
  type: ResourceType;
  amount: number;
  unit: string;
}
