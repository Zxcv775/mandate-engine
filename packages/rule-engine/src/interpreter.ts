import type { Rule, RuleEffect, RuleScope } from "@mandate/domain";
import { RuleSchema } from "@mandate/domain";
import { evaluateCondition, type RuleEvaluationContext } from "./condition";
import { RuleEngineError } from "./errors";

/**
 * 规则解释器（ADR-022）：纯函数，零 LLM、零 IO、零持久化。
 * 求值顺序稳定：priority 降序 → ruleId 字典序；每条命中入 trace。
 */

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly scope: RuleScope;
  readonly priority: number;
  readonly matched: boolean;
  readonly effectCount: number;
  readonly note?: string;
}

export interface TriggeredRule {
  readonly rule: Rule;
  readonly effects: readonly RuleEffect[];
}

export interface EvaluateRulesInput {
  readonly rules: readonly Rule[];
  readonly scope: RuleScope;
  readonly context: RuleEvaluationContext;
}

export interface EvaluateRulesResult {
  readonly triggered: readonly TriggeredRule[];
  readonly trace: readonly RuleTraceEntry[];
}

export function sortRulesDeterministically(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function evaluateRules(input: EvaluateRulesInput): EvaluateRulesResult {
  const trace: RuleTraceEntry[] = [];
  const triggered: TriggeredRule[] = [];
  const scoped = sortRulesDeterministically(
    input.rules.filter((rule) => rule.scope === input.scope),
  );
  for (const rule of scoped) {
    // 防御手工构造对象绕过加载期校验（RULE_SCHEMA_INVALID）
    const parsed = RuleSchema.safeParse(rule);
    if (!parsed.success) {
      throw new RuleEngineError(
        "RULE_SCHEMA_INVALID",
        `规则 ${rule.id} 未通过 Schema 校验`,
        parsed.error.issues,
      );
    }
    const matched = evaluateCondition(rule.condition, input.context);
    trace.push({
      ruleId: rule.id,
      scope: rule.scope,
      priority: rule.priority,
      matched,
      effectCount: matched ? rule.effects.length : 0,
    });
    if (matched) {
      triggered.push({ rule, effects: rule.effects });
    }
  }
  return { triggered, trace };
}
