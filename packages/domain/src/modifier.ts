import { z } from "zod";

/**
 * 统一 Modifier 系统（Phase 5，ADR-024）。
 * 运行态 Modifier 存放于 GameState.modifiers（世界事实，随快照/回放/回滚走），
 * 一切数值修饰（国家/地区/人物/政策）经 resolveEffectiveValue 统一合成。
 * 红线：
 * - Modifier 只能经白名单 GameCommand / 规则引擎 effect 产生，LLM 不得直接构造；
 * - 应用顺序确定：add 先于 mul，再 clamp-min / clamp-max；同类按 modifierId 字典序；
 * - 过期清理在时间推进事务内完成并留痕（StateChangeLog 可见）。
 */

const IdSchema = z.string().trim().min(1);
const NonNegativeInt = z.number().int().nonnegative();

/** Modifier 作用目标：国家 / 指定地区 / 指定人物 / 指定政策 */
export const ModifierTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("country") }).strict(),
  z.object({ kind: z.literal("region"), regionId: IdSchema }).strict(),
  z.object({ kind: z.literal("character"), characterId: IdSchema }).strict(),
  z.object({ kind: z.literal("policy"), policyId: IdSchema }).strict(),
]);
export type ModifierTarget = z.infer<typeof ModifierTargetSchema>;

/** 目标类型 → 可修饰指标白名单（规则引擎与命令层共用） */
export const MODIFIER_METRIC_WHITELIST: Readonly<
  Record<ModifierTarget["kind"], readonly string[]>
> = {
  country: ["legitimacy", "stability", "administrativeCapacity", "militaryReadiness"],
  region: ["stability"],
  character: ["favor", "loyaltyToEmperor", "stress"],
  policy: ["executionEfficiency", "resistance"],
};

export const ModifierOperationKindSchema = z.enum(["add", "mul", "clamp-min", "clamp-max"]);
export type ModifierOperationKind = z.infer<typeof ModifierOperationKindSchema>;

/** Modifier 来源：政策 / 事件 / 规则 / 系统（如场景初始） */
export const ModifierSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("policy"), policyId: IdSchema }).strict(),
  z.object({ kind: z.literal("event"), eventId: IdSchema }).strict(),
  z.object({ kind: z.literal("rule"), ruleId: IdSchema }).strict(),
  z.object({ kind: z.literal("system"), label: z.string().trim().min(1) }).strict(),
]);
export type ModifierSource = z.infer<typeof ModifierSourceSchema>;

export const ModifierStackingSchema = z.enum(["stack", "unique-by-source", "replace"]);
export type ModifierStacking = z.infer<typeof ModifierStackingSchema>;

export const ModifierStateSchema = z
  .object({
    modifierId: IdSchema,
    target: ModifierTargetSchema,
    metric: z.string().trim().min(1),
    operation: ModifierOperationKindSchema,
    value: z.number().finite(),
    source: ModifierSourceSchema,
    /** 生效 tick（含）；结算时 tick >= effectiveTick 才参与合成 */
    effectiveTick: NonNegativeInt,
    /** 过期 tick（不含）；null 表示永久 */
    expiresAtTick: NonNegativeInt.nullable(),
    stacking: ModifierStackingSchema,
    reason: z.string().trim().min(1),
    sourceIds: z.array(IdSchema),
  })
  .strict()
  .superRefine((modifier, context) => {
    const allowed = MODIFIER_METRIC_WHITELIST[modifier.target.kind];
    if (!allowed.includes(modifier.metric)) {
      context.addIssue({
        code: "custom",
        path: ["metric"],
        message: `目标 ${modifier.target.kind} 不允许修饰指标 ${modifier.metric}`,
      });
    }
    if (modifier.expiresAtTick !== null && modifier.expiresAtTick <= modifier.effectiveTick) {
      context.addIssue({
        code: "custom",
        path: ["expiresAtTick"],
        message: "过期 tick 必须晚于生效 tick（或为 null 表示永久）",
      });
    }
  });
export type ModifierState = z.infer<typeof ModifierStateSchema>;

/**
 * 模板层 Modifier 声明（政策模板 / 规则 effect 内嵌）：
 * 不含 modifierId / source / effectiveTick——运行时由引擎按来源与当前 tick 实例化。
 */
export const ModifierTemplateSchema = z
  .object({
    target: ModifierTargetSchema.or(
      // 模板中允许上下文占位：结算时由引擎解析为具体实体
      z.object({ kind: z.literal("context-policy") }).strict(),
    ).or(z.object({ kind: z.literal("context-region") }).strict()),
    metric: z.string().trim().min(1),
    operation: ModifierOperationKindSchema,
    value: z.number().finite(),
    /** 持续 tick 数；null 表示永久 */
    durationTicks: z.number().int().positive().nullable(),
    stacking: ModifierStackingSchema,
    reason: z.string().trim().min(1),
  })
  .strict();
export type ModifierTemplate = z.infer<typeof ModifierTemplateSchema>;
