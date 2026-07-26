import type {
  GameState,
  ModifierState,
  ModifierTarget,
  ProposedMutation,
  RuleEffect,
} from "@mandate/domain";
import { RuleEngineError } from "./errors";

/**
 * 白名单 effect → 候选 Mutation 规划（ADR-022）。
 * 纯函数：不落库；产出交由 StateEngine 校验与原子提交。
 * 语义：
 * - 数值指标 0-100 clamp；资源不允许为负（超扣按余额封顶并入 note）；
 * - 同一路径多次调整按声明顺序在工作副本上顺序累计；
 * - Modifier 实例化命名确定（来源 + 规则 + tick），同键幂等覆盖检查。
 */

export interface EffectPlanContext {
  readonly tick: number;
  /** effect 归属（规则/模板阶段等），用于 Modifier 命名与留痕 */
  readonly sourceKind: "rule" | "policy" | "system";
  readonly sourceId: string;
  /** 上下文政策（advance-policy-progress / set-policy-blocked / context-policy 必需） */
  readonly policyId?: string;
  readonly contextRegionId?: string;
  readonly responsibleCharacterIds?: readonly string[];
  readonly sourceIds?: readonly string[];
}

export interface EffectPlanNote {
  readonly effectType: RuleEffect["type"];
  readonly note: string;
}

export interface EffectPlanResult {
  readonly mutations: readonly ProposedMutation[];
  readonly notes: readonly EffectPlanNote[];
}

const COUNTRY_METRIC_LIMIT = { min: 0, max: 100 } as const;

function clampMetric(value: number): number {
  return Math.max(COUNTRY_METRIC_LIMIT.min, Math.min(COUNTRY_METRIC_LIMIT.max, Math.round(value)));
}

function mutation(
  input: Omit<ProposedMutation, "sourceIds" | "visibility"> &
    Partial<Pick<ProposedMutation, "sourceIds" | "visibility">>,
): ProposedMutation {
  return {
    ...input,
    sourceIds: input.sourceIds ?? [],
    visibility: input.visibility ?? "internal",
  };
}

/** 读取工作副本上的当前值（含本轮已应用的 mutations） */
class WorkingValues {
  private readonly values = new Map<string, number>();

  constructor(private readonly state: GameState) {}

  get(path: string, fallback: () => number): number {
    const cached = this.values.get(path);
    if (cached !== undefined) return cached;
    const value = fallback();
    this.values.set(path, value);
    return value;
  }

  set(path: string, value: number): void {
    this.values.set(path, value);
  }
}

function resolveModifierTemplateTarget(
  target: { kind: string } & Record<string, unknown>,
  context: EffectPlanContext,
): ModifierTarget {
  if (target.kind === "context-policy") {
    if (!context.policyId) {
      throw new RuleEngineError("MODIFIER_TARGET_NOT_FOUND", "缺少上下文政策，无法实例化 Modifier");
    }
    return { kind: "policy", policyId: context.policyId };
  }
  if (target.kind === "context-region") {
    if (!context.contextRegionId) {
      throw new RuleEngineError("MODIFIER_TARGET_NOT_FOUND", "缺少上下文地区，无法实例化 Modifier");
    }
    return { kind: "region", regionId: context.contextRegionId };
  }
  return target as ModifierTarget;
}

export function planEffectMutations(
  state: GameState,
  effects: readonly RuleEffect[],
  context: EffectPlanContext,
): EffectPlanResult {
  const mutations: ProposedMutation[] = [];
  const notes: EffectPlanNote[] = [];
  const working = new WorkingValues(state);
  const sourceIds = [...(context.sourceIds ?? [])];
  let modifierSequence = 0;
  let queuedEvents = [...state.hidden.queuedEventIds];

  for (const effect of effects) {
    switch (effect.type) {
      case "adjust-country-resource": {
        const path = `/country/${effect.resource}`;
        const before = working.get(path, () => state.country[effect.resource]);
        let after = before + effect.amount;
        if (after < 0) {
          notes.push({
            effectType: effect.type,
            note: `${effect.resource} 余额不足：请求 ${effect.amount}，按余额封顶扣至 0`,
          });
          after = 0;
        }
        if (after === before) break;
        working.set(path, after);
        mutations.push(
          mutation({
            aggregateType: "country",
            operation: effect.amount > 0 ? "increment" : "decrement",
            path,
            before,
            after,
            reason: effect.reason,
            sourceIds,
            visibility: "public",
            tags: ["rule-effect", "resource"],
          }),
        );
        break;
      }
      case "adjust-country-metric": {
        const path = `/country/${effect.metric}`;
        const before = working.get(path, () => state.country[effect.metric]);
        const after = clampMetric(before + effect.amount);
        if (after === before) break;
        working.set(path, after);
        mutations.push(
          mutation({
            aggregateType: "country",
            operation: "set",
            path,
            before,
            after,
            reason: effect.reason,
            sourceIds,
            visibility: "public",
            tags: ["rule-effect", "metric"],
          }),
        );
        break;
      }
      case "adjust-region-metric": {
        const regionId = effect.region === "context" ? context.contextRegionId : effect.region;
        if (!regionId || !state.regions[regionId]) {
          notes.push({
            effectType: effect.type,
            note: `地区不存在或缺少上下文地区：${String(effect.region)}，效果跳过`,
          });
          break;
        }
        const path = `/regions/${regionId}/${effect.metric}`;
        const before = working.get(path, () => state.regions[regionId]![effect.metric]);
        const after = clampMetric(before + effect.amount);
        if (after === before) break;
        working.set(path, after);
        mutations.push(
          mutation({
            aggregateType: "region",
            entityId: regionId,
            operation: "set",
            path,
            before,
            after,
            reason: effect.reason,
            sourceIds,
            visibility: "public",
            tags: ["rule-effect", "region"],
          }),
        );
        break;
      }
      case "adjust-character-metric": {
        const characterId =
          effect.character === "responsible"
            ? context.responsibleCharacterIds?.[0]
            : effect.character;
        if (!characterId || !state.characters[characterId]) {
          notes.push({
            effectType: effect.type,
            note: `人物不存在或缺少负责人上下文：${String(effect.character)}，效果跳过`,
          });
          break;
        }
        const path = `/characters/${characterId}/${effect.metric}`;
        const character = state.characters[characterId]!;
        const before = working.get(path, () => character[effect.metric]);
        const bounds = effect.metric === "favor" ? { min: -100, max: 100 } : { min: 0, max: 100 };
        const after = Math.max(
          bounds.min,
          Math.min(bounds.max, Math.round(before + effect.amount)),
        );
        if (after === before) break;
        working.set(path, after);
        mutations.push(
          mutation({
            aggregateType: "character",
            entityId: characterId,
            operation: "set",
            path,
            before,
            after,
            reason: effect.reason,
            sourceIds,
            visibility: "internal",
            tags: ["rule-effect", "character"],
          }),
        );
        break;
      }
      case "add-modifier": {
        const target = resolveModifierTemplateTarget(effect.modifier.target, context);
        modifierSequence += 1;
        const modifierId = `mod_${context.sourceKind}_${context.sourceId}_${context.tick}_${modifierSequence}`;
        if (state.modifiers[modifierId]) {
          notes.push({
            effectType: effect.type,
            note: `Modifier 已存在（幂等跳过）：${modifierId}`,
          });
          break;
        }
        const instance: ModifierState = {
          modifierId,
          target,
          metric: effect.modifier.metric,
          operation: effect.modifier.operation,
          value: effect.modifier.value,
          source:
            context.sourceKind === "rule"
              ? { kind: "rule", ruleId: context.sourceId }
              : context.sourceKind === "policy"
                ? { kind: "policy", policyId: context.policyId ?? context.sourceId }
                : { kind: "system", label: context.sourceId },
          effectiveTick: context.tick,
          expiresAtTick:
            effect.modifier.durationTicks === null
              ? null
              : context.tick + effect.modifier.durationTicks,
          stacking: effect.modifier.stacking,
          reason: effect.modifier.reason,
          sourceIds,
        };
        mutations.push(
          mutation({
            aggregateType: "modifier",
            entityId: modifierId,
            operation: "add",
            path: `/modifiers/${modifierId}`,
            before: null,
            after: instance,
            reason: effect.modifier.reason,
            sourceIds,
            tags: ["rule-effect", "modifier"],
          }),
        );
        break;
      }
      case "remove-modifier": {
        for (const modifier of Object.values(state.modifiers)
          .filter((candidate) => JSON.stringify(candidate.source).includes(effect.bySource))
          .sort((a, b) => a.modifierId.localeCompare(b.modifierId))) {
          mutations.push(
            mutation({
              aggregateType: "modifier",
              entityId: modifier.modifierId,
              operation: "remove",
              path: `/modifiers/${modifier.modifierId}`,
              before: modifier,
              after: null,
              reason: effect.reason,
              sourceIds,
              tags: ["rule-effect", "modifier"],
            }),
          );
        }
        break;
      }
      case "advance-policy-progress":
      case "set-policy-blocked": {
        // 政策进度/阻滞由结算引擎聚合到整记录 set（resolution.ts），
        // 独立出现时（如 approve 期误配）明确拒绝，避免旁路写进度。
        throw new RuleEngineError(
          "RULE_EFFECT_UNSUPPORTED",
          `效果 ${effect.type} 仅允许出现在政策结算上下文`,
        );
      }
      case "queue-event-candidate": {
        if (queuedEvents.includes(effect.eventId)) {
          notes.push({ effectType: effect.type, note: `事件候选已在队列：${effect.eventId}` });
          break;
        }
        const before = queuedEvents;
        queuedEvents = [...queuedEvents, effect.eventId];
        mutations.push(
          mutation({
            aggregateType: "hidden",
            operation: "set",
            path: "/hidden/queuedEventIds",
            before,
            after: queuedEvents,
            reason: `规则触发事件候选：${effect.eventId}`,
            sourceIds,
            visibility: "sealed",
            tags: ["rule-effect", "event-candidate"],
          }),
        );
        break;
      }
    }
  }
  return { mutations, notes };
}
