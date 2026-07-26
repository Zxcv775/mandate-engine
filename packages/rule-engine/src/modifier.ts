import type { GameState, ModifierState, ModifierTarget, ProposedMutation } from "@mandate/domain";
import { MODIFIER_METRIC_WHITELIST } from "@mandate/domain";
import { RuleEngineError } from "./errors";

/**
 * Modifier 合成（ADR-024）。
 * 应用顺序确定：add（按 modifierId 字典序）→ mul（同序）→ clamp-min → clamp-max。
 * 叠加语义：
 * - stack：全部生效；
 * - unique-by-source：同一来源键（source 序列化）只取 modifierId 最小的一个；
 * - replace：同 (target, metric, operation) 组只保留 effectiveTick 最大者，
 *   同 tick 再按 modifierId 最大者（后写覆盖，确定性）。
 */

export function modifierTargetKey(target: ModifierTarget): string {
  switch (target.kind) {
    case "country":
      return "country";
    case "region":
      return `region:${target.regionId}`;
    case "character":
      return `character:${target.characterId}`;
    case "policy":
      return `policy:${target.policyId}`;
  }
}

function sourceKey(modifier: ModifierState): string {
  const source = modifier.source;
  switch (source.kind) {
    case "policy":
      return `policy:${source.policyId}`;
    case "event":
      return `event:${source.eventId}`;
    case "rule":
      return `rule:${source.ruleId}`;
    case "system":
      return `system:${source.label}`;
  }
}

function isActiveAt(modifier: ModifierState, tick: number): boolean {
  if (tick < modifier.effectiveTick) return false;
  if (modifier.expiresAtTick !== null && tick >= modifier.expiresAtTick) return false;
  return true;
}

/** 选取指定目标/指标在 tick 时点生效的 Modifier（叠加语义去重后，按 modifierId 字典序） */
export function selectActiveModifiers(
  modifiers: Readonly<Record<string, ModifierState>>,
  target: ModifierTarget,
  metric: string,
  tick: number,
): ModifierState[] {
  const targetKey = modifierTargetKey(target);
  const candidates = Object.values(modifiers)
    .filter(
      (modifier) =>
        modifierTargetKey(modifier.target) === targetKey &&
        modifier.metric === metric &&
        isActiveAt(modifier, tick),
    )
    .sort((a, b) => a.modifierId.localeCompare(b.modifierId));

  const result: ModifierState[] = [];
  const seenSources = new Set<string>();
  const replaceGroups = new Map<string, ModifierState>();
  for (const modifier of candidates) {
    if (modifier.stacking === "unique-by-source") {
      const key = `${sourceKey(modifier)}|${modifier.operation}`;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      result.push(modifier);
    } else if (modifier.stacking === "replace") {
      const key = modifier.operation;
      const current = replaceGroups.get(key);
      if (
        !current ||
        modifier.effectiveTick > current.effectiveTick ||
        (modifier.effectiveTick === current.effectiveTick &&
          modifier.modifierId.localeCompare(current.modifierId) > 0)
      ) {
        replaceGroups.set(key, modifier);
      }
    } else {
      result.push(modifier);
    }
  }
  result.push(...replaceGroups.values());
  return result.sort((a, b) => a.modifierId.localeCompare(b.modifierId));
}

export interface AppliedModifierStep {
  readonly modifierId: string;
  readonly operation: ModifierState["operation"];
  readonly value: number;
  readonly resultAfter: number;
}

export interface ModifierStackResult {
  readonly value: number;
  readonly applied: readonly AppliedModifierStep[];
}

/** 按确定顺序合成：add → mul → clamp-min → clamp-max */
export function applyModifierStack(
  baseValue: number,
  modifiers: readonly ModifierState[],
): ModifierStackResult {
  const ordered = [
    ...modifiers.filter((m) => m.operation === "add"),
    ...modifiers.filter((m) => m.operation === "mul"),
    ...modifiers.filter((m) => m.operation === "clamp-min"),
    ...modifiers.filter((m) => m.operation === "clamp-max"),
  ];
  let value = baseValue;
  const applied: AppliedModifierStep[] = [];
  for (const modifier of ordered) {
    switch (modifier.operation) {
      case "add":
        value += modifier.value;
        break;
      case "mul":
        value *= modifier.value;
        break;
      case "clamp-min":
        value = Math.max(value, modifier.value);
        break;
      case "clamp-max":
        value = Math.min(value, modifier.value);
        break;
    }
    applied.push({
      modifierId: modifier.modifierId,
      operation: modifier.operation,
      value: modifier.value,
      resultAfter: value,
    });
  }
  return { value, applied };
}

/** 政策虚拟指标的基准值（GameState 中无存储字段，仅在结算内合成） */
const POLICY_METRIC_BASE: Readonly<Record<string, number>> = {
  executionEfficiency: 1,
  resistance: 0,
};

function baseValueOf(state: GameState, target: ModifierTarget, metric: string): number {
  switch (target.kind) {
    case "country": {
      const value = (state.country as unknown as Record<string, unknown>)[metric];
      if (typeof value !== "number") {
        throw new RuleEngineError("MODIFIER_INVALID", `国家指标不存在：${metric}`);
      }
      return value;
    }
    case "region": {
      const region = state.regions[target.regionId];
      if (!region) {
        throw new RuleEngineError("MODIFIER_TARGET_NOT_FOUND", `地区不存在：${target.regionId}`);
      }
      const value = (region as unknown as Record<string, unknown>)[metric];
      if (typeof value !== "number") {
        throw new RuleEngineError("MODIFIER_INVALID", `地区指标不存在：${metric}`);
      }
      return value;
    }
    case "character": {
      const character = state.characters[target.characterId];
      if (!character) {
        throw new RuleEngineError("MODIFIER_TARGET_NOT_FOUND", `人物不存在：${target.characterId}`);
      }
      const value = (character as unknown as Record<string, unknown>)[metric];
      if (typeof value !== "number") {
        throw new RuleEngineError("MODIFIER_INVALID", `人物指标不存在：${metric}`);
      }
      return value;
    }
    case "policy": {
      if (!state.policies[target.policyId]) {
        throw new RuleEngineError("MODIFIER_TARGET_NOT_FOUND", `政策不存在：${target.policyId}`);
      }
      const base = POLICY_METRIC_BASE[metric];
      if (base === undefined) {
        throw new RuleEngineError("MODIFIER_INVALID", `政策指标不存在：${metric}`);
      }
      return base;
    }
  }
}

/**
 * 统一有效值合成入口：各引擎读取"受 Modifier 修饰后的指标"必须经此函数。
 * 纯函数；指标必须在目标类型的白名单内。
 */
export function resolveEffectiveValue(
  state: GameState,
  target: ModifierTarget,
  metric: string,
  tick: number = state.tick,
): ModifierStackResult {
  if (!MODIFIER_METRIC_WHITELIST[target.kind].includes(metric)) {
    throw new RuleEngineError("MODIFIER_INVALID", `目标 ${target.kind} 不允许读取指标 ${metric}`);
  }
  const base = baseValueOf(state, target, metric);
  return applyModifierStack(base, selectActiveModifiers(state.modifiers, target, metric, tick));
}

/** 过期清理：时间推进事务内调用，产出 remove mutations 留痕（StateChangeLog 可见） */
export function planExpiredModifierCleanup(state: GameState, tick: number): ProposedMutation[] {
  const mutations: ProposedMutation[] = [];
  for (const modifier of Object.values(state.modifiers).sort((a, b) =>
    a.modifierId.localeCompare(b.modifierId),
  )) {
    if (modifier.expiresAtTick !== null && tick >= modifier.expiresAtTick) {
      mutations.push({
        aggregateType: "modifier",
        entityId: modifier.modifierId,
        operation: "remove",
        path: `/modifiers/${modifier.modifierId}`,
        before: modifier,
        after: null,
        reason: `Modifier 到期清理（tick ${tick}）：${modifier.reason}`,
        sourceIds: [...modifier.sourceIds],
        visibility: "internal",
        tags: ["modifier", "expiry"],
      });
    }
  }
  return mutations;
}
