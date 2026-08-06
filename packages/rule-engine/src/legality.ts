import type { Rule, RuleEffect } from "@mandate/domain";
import { evaluateRules, type RuleTraceEntry } from "./interpreter";
import type { RuleEvaluationContext } from "./condition";

/**
 * 政策合法性检查（§8.4，ADR-023）。
 * 御批（policy.approve）时执行 scope=policy-legality 规则：
 * - 直诏（direct-decree）承担规则数据驱动的合法性/威望扣减与执行阻力 Modifier；
 * - 规则含 set-policy-blocked 效果时，御批被 POLICY_LEGALITY_BLOCKED 拒绝。
 * 返回原始 effect 清单（不规划 mutation）：调用方将其与模板基础影响合并后
 * 在同一工作副本上单次规划，避免同路径 before 冲突。
 */

export interface LegalityEvaluationInput {
  readonly rules: readonly Rule[];
  readonly context: RuleEvaluationContext;
}

export interface LegalityEvaluationResult {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly effects: readonly RuleEffect[];
  readonly trace: readonly RuleTraceEntry[];
}

export function evaluatePolicyLegality(input: LegalityEvaluationInput): LegalityEvaluationResult {
  const { triggered, trace } = evaluateRules({
    rules: input.rules,
    scope: "policy-legality",
    context: input.context,
  });

  const effects = triggered.flatMap((entry) => entry.effects);
  const blockedEffect = effects.find((effect) => effect.type === "set-policy-blocked");
  if (blockedEffect && blockedEffect.type === "set-policy-blocked") {
    return { blocked: true, blockedReason: blockedEffect.reason, effects: [], trace };
  }
  return {
    blocked: false,
    effects: effects.filter(
      (effect) => effect.type !== "advance-policy-progress" && effect.type !== "set-policy-blocked",
    ),
    trace,
  };
}
