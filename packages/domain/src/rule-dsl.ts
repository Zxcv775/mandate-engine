import { z } from "zod";
import { ModifierTemplateSchema } from "./modifier";

/**
 * 数据驱动规则 DSL（Phase 5，ADR-022）。
 * 规则以受校验的 JSON 存放于 data/rules，由纯函数解释器执行。
 * 红线：
 * - 禁止内嵌可执行代码 / 表达式求值 / eval / new Function；
 * - conditions 为受限比较树：仅白名单路径 × 有限比较算子，深度受限；
 * - effects 只允许白名单动作；hidden 区不可作为条件输入（防泄露通道）；
 * - 求值顺序稳定：priority 降序，同分按 ruleId 字典序。
 */

const IdSchema = z.string().trim().min(1);
const TextSchema = z.string().trim().min(1);

/**
 * 条件路径白名单文法（RULE_CONDITION_PATH_FORBIDDEN 拒绝一切之外的路径）：
 * - country.<treasuryTaels|grainReserveShi|legitimacy|stability|administrativeCapacity|militaryReadiness>
 * - region.<stability|population>            —— 上下文地区（政策 scope 涉及地区时）
 * - region:<id>.<stability|population>       —— 指定地区
 * - character.<favor|loyaltyToEmperor|stress|status|moralFlexibility|competence>
 *                                            —— 上下文人物（政策负责人）
 * - character:<id>.<...同上>                 —— 指定人物
 * - policy.<status|category|source|currentStageIndex|stageProgress|overallProgress|complexity|legitimacyCostAccrued|fundingRatio>
 *                                            —— 上下文政策
 * - flags.<key>                              —— 布尔标志
 * 注意：hidden.* 与其余任何路径一律禁止（解释器双重校验）。
 */
export const CONDITION_PATH_PATTERN =
  /^(country\.(treasuryTaels|grainReserveShi|legitimacy|stability|administrativeCapacity|militaryReadiness)|region(:[a-z0-9-]+)?\.(stability|population)|character(:[a-z0-9-]+)?\.(favor|loyaltyToEmperor|stress|status|moralFlexibility|competence)|policy\.(status|category|source|currentStageIndex|stageProgress|overallProgress|complexity|legitimacyCostAccrued|fundingRatio)|flags\.[A-Za-z0-9_.-]+)$/;

export const ConditionPathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(CONDITION_PATH_PATTERN, "条件路径不在白名单内（RULE_CONDITION_PATH_FORBIDDEN）");
export type ConditionPath = z.infer<typeof ConditionPathSchema>;

const ScalarSchema = z.union([z.number().finite(), z.string(), z.boolean()]);

export interface RuleCondition {
  readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "and" | "or" | "not";
  readonly path?: string;
  readonly value?: number | string | boolean;
  readonly values?: readonly (number | string)[];
  readonly conditions?: readonly RuleCondition[];
  readonly condition?: RuleCondition;
}

const ComparisonSchema = z
  .object({
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    path: ConditionPathSchema,
    value: ScalarSchema,
  })
  .strict();

const InSchema = z
  .object({
    op: z.literal("in"),
    path: ConditionPathSchema,
    values: z
      .array(z.union([z.number().finite(), z.string()]))
      .min(1)
      .max(20),
  })
  .strict();

export const RuleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    ComparisonSchema,
    InSchema,
    z
      .object({
        op: z.enum(["and", "or"]),
        conditions: z.array(RuleConditionSchema).min(1).max(8),
      })
      .strict(),
    z.object({ op: z.literal("not"), condition: RuleConditionSchema }).strict(),
  ]),
);

/** 条件树最大深度（superRefine 强制，防御深度炸弹） */
export const MAX_CONDITION_DEPTH = 5;

export function measureConditionDepth(condition: RuleCondition): number {
  if (condition.op === "not") {
    return 1 + measureConditionDepth(condition.condition!);
  }
  if (condition.op === "and" || condition.op === "or") {
    return 1 + Math.max(...condition.conditions!.map(measureConditionDepth));
  }
  return 1;
}

/** 效果白名单（§6.4）。超出者一律 RULE_EFFECT_UNSUPPORTED 拒绝加载。 */
export const RuleEffectSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("adjust-country-resource"),
      resource: z.enum(["treasuryTaels", "grainReserveShi"]),
      amount: z
        .number()
        .int()
        .refine((value) => value !== 0, "调整量不得为零"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjust-country-metric"),
      metric: z.enum(["legitimacy", "stability", "administrativeCapacity", "militaryReadiness"]),
      amount: z
        .number()
        .int()
        .refine((value) => value !== 0, "调整量不得为零"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjust-region-metric"),
      /** "context" 表示政策上下文地区 */
      region: z.union([z.literal("context"), IdSchema]),
      metric: z.enum(["stability"]),
      amount: z
        .number()
        .int()
        .refine((value) => value !== 0, "调整量不得为零"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjust-character-metric"),
      /** "responsible" 表示政策负责人 */
      character: z.union([z.literal("responsible"), IdSchema]),
      metric: z.enum(["favor", "loyaltyToEmperor", "stress"]),
      amount: z
        .number()
        .int()
        .refine((value) => value !== 0, "调整量不得为零"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("add-modifier"),
      modifier: ModifierTemplateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("remove-modifier"),
      /** 按来源清除：policyId / eventId / ruleId */
      bySource: IdSchema,
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("advance-policy-progress"),
      amount: z
        .number()
        .int()
        .refine((value) => value !== 0, "调整量不得为零"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set-policy-blocked"),
      reason: TextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("queue-event-candidate"),
      /** 仅写入 hidden.queuedEventIds 供 Phase 6 消费，不展开后果 */
      eventId: IdSchema,
    })
    .strict(),
]);
export type RuleEffect = z.infer<typeof RuleEffectSchema>;

export const RuleScopeSchema = z.enum(["policy-resolution", "policy-legality", "modifier"]);
export type RuleScope = z.infer<typeof RuleScopeSchema>;

export const RuleSchema = z
  .object({
    id: IdSchema,
    version: z.number().int().positive(),
    scope: RuleScopeSchema,
    description: TextSchema,
    /** priority 降序求值；同分按 id 字典序（确定性） */
    priority: z.number().int().min(-1000).max(1000),
    /** 根条件；恒真规则用 {"op":"gte","path":"policy.overallProgress","value":0} 这类显式条件 */
    condition: RuleConditionSchema,
    effects: z.array(RuleEffectSchema).min(1).max(8),
    /** 若源自史实机制则关联史料 */
    sourceIds: z.array(IdSchema),
  })
  .strict()
  .superRefine((rule, context) => {
    if (measureConditionDepth(rule.condition) > MAX_CONDITION_DEPTH) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: `条件树深度超过上限 ${MAX_CONDITION_DEPTH}`,
      });
    }
  });
export type Rule = z.infer<typeof RuleSchema>;
