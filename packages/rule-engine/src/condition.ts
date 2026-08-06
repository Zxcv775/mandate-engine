import type {
  CountryRuntimeState,
  PolicyRuntimeState,
  PolicyTemplate,
  RegionRuntimeState,
  RuleCondition,
} from "@mandate/domain";
import { CONDITION_PATH_PATTERN } from "@mandate/domain";
import { RuleEngineError } from "./errors";

/**
 * 条件求值（ADR-022）。
 * 路径经白名单投影读取：hidden 区与任何白名单外路径在此二次拦截
 * （Schema 已在加载期拦截一次，这里防御手工构造的规则对象）。
 * 未解析出值（实体缺失/指标未提供）时比较结果一律为 false，不抛错。
 */

export interface RuleCharacterMetrics {
  readonly favor: number;
  readonly loyaltyToEmperor: number;
  readonly stress: number;
  readonly status: string;
  /** 来自人物卡（0-100）；上下文未提供时为 undefined */
  readonly moralFlexibility?: number;
  readonly competence?: number;
}

export interface RuleEvaluationContext {
  readonly tick: number;
  readonly country: CountryRuntimeState;
  readonly regions: Readonly<Record<string, RegionRuntimeState>>;
  readonly flags: Readonly<Record<string, unknown>>;
  /** 上下文政策（policy-resolution / policy-legality 作用域） */
  readonly policy?: PolicyRuntimeState;
  readonly template?: PolicyTemplate;
  /** 政策上下文地区（regional scope 的第一个地区） */
  readonly contextRegionId?: string;
  /** 结算期计算：维持成本到位率 0..1 */
  readonly fundingRatio?: number;
  /** "responsible" 或具体人物 ID → 指标；未知返回 undefined */
  readonly resolveCharacter?: (ref: string) => RuleCharacterMetrics | undefined;
}

type Scalar = number | string | boolean;

function characterMetric(
  context: RuleEvaluationContext,
  ref: string,
  metric: string,
): Scalar | undefined {
  const character = context.resolveCharacter?.(ref);
  if (!character) return undefined;
  switch (metric) {
    case "favor":
      return character.favor;
    case "loyaltyToEmperor":
      return character.loyaltyToEmperor;
    case "stress":
      return character.stress;
    case "status":
      return character.status;
    case "moralFlexibility":
      return character.moralFlexibility;
    case "competence":
      return character.competence;
    default:
      return undefined;
  }
}

function regionMetric(region: RegionRuntimeState | undefined, metric: string): Scalar | undefined {
  if (!region) return undefined;
  if (metric === "stability") return region.stability;
  if (metric === "population") return region.population;
  return undefined;
}

function policyField(context: RuleEvaluationContext, field: string): Scalar | undefined {
  const policy = context.policy;
  if (!policy) return undefined;
  switch (field) {
    case "status":
      return policy.status;
    case "category":
      return context.template?.category;
    case "source":
      return policy.origin.kind;
    case "currentStageIndex":
      return policy.currentStageIndex;
    case "stageProgress":
      return policy.stageProgress;
    case "overallProgress":
      return policy.overallProgress;
    case "complexity":
      return context.template?.resistance.administrativeDifficulty;
    case "legitimacyCostAccrued":
      return policy.legitimacyCostAccrued;
    case "fundingRatio":
      return context.fundingRatio;
    default:
      return undefined;
  }
}

/** 白名单路径投影；白名单外一律 RULE_CONDITION_PATH_FORBIDDEN */
export function resolveConditionPath(
  path: string,
  context: RuleEvaluationContext,
): Scalar | undefined {
  if (!CONDITION_PATH_PATTERN.test(path)) {
    throw new RuleEngineError("RULE_CONDITION_PATH_FORBIDDEN", `条件路径不在白名单内：${path}`);
  }
  if (path.startsWith("country.")) {
    const metric = path.slice("country.".length);
    return (context.country as unknown as Record<string, unknown>)[metric] as Scalar | undefined;
  }
  if (path.startsWith("region:")) {
    const [head, metric] = path.split(".");
    return regionMetric(context.regions[head!.slice("region:".length)], metric!);
  }
  if (path.startsWith("region.")) {
    const regionId = context.contextRegionId;
    return regionMetric(regionId ? context.regions[regionId] : undefined, path.slice(7));
  }
  if (path.startsWith("character:")) {
    const [head, metric] = path.split(".");
    return characterMetric(context, head!.slice("character:".length), metric!);
  }
  if (path.startsWith("character.")) {
    return characterMetric(context, "responsible", path.slice("character.".length));
  }
  if (path.startsWith("policy.")) {
    return policyField(context, path.slice("policy.".length));
  }
  if (path.startsWith("flags.")) {
    const value = context.flags[path.slice("flags.".length)];
    return typeof value === "number" || typeof value === "string" || typeof value === "boolean"
      ? value
      : undefined;
  }
  throw new RuleEngineError("RULE_CONDITION_PATH_FORBIDDEN", `条件路径不在白名单内：${path}`);
}

export function evaluateCondition(
  condition: RuleCondition,
  context: RuleEvaluationContext,
): boolean {
  switch (condition.op) {
    case "and":
      return condition.conditions!.every((child) => evaluateCondition(child, context));
    case "or":
      return condition.conditions!.some((child) => evaluateCondition(child, context));
    case "not":
      return !evaluateCondition(condition.condition!, context);
    case "in": {
      const value = resolveConditionPath(condition.path!, context);
      return value !== undefined && condition.values!.includes(value as number | string);
    }
    default: {
      const value = resolveConditionPath(condition.path!, context);
      if (value === undefined) return false;
      const expected = condition.value!;
      switch (condition.op) {
        case "eq":
          return value === expected;
        case "ne":
          return value !== expected;
        case "gt":
          return typeof value === "number" && typeof expected === "number" && value > expected;
        case "gte":
          return typeof value === "number" && typeof expected === "number" && value >= expected;
        case "lt":
          return typeof value === "number" && typeof expected === "number" && value < expected;
        case "lte":
          return typeof value === "number" && typeof expected === "number" && value <= expected;
      }
    }
  }
}
