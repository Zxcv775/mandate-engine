import type {
  GameState,
  ModifierState,
  PolicyReport,
  PolicyResolutionBreakdown,
  PolicyRuntimeState,
  PolicyTruth,
  ProposedMutation,
  RuleEffect,
} from "@mandate/domain";
import {
  evaluateRules,
  planEffectMutations,
  planExpiredModifierCleanup,
  resolveEffectiveValue,
  resolvePolicyTick,
  renderReportText,
  type EffectPlanNote,
  type RuleEvaluationContext,
  type RuleTraceEntry,
  type TriggeredDeviation,
} from "@mandate/rule-engine";
import { fnv1a } from "@mandate/shared";
import { transitionPolicy, type PolicyCommandAssets } from "./policy-commands";
import { applyMutations } from "./mutation";
import { createDeterministicRandomSource } from "./rng";

/**
 * 政策执行结算编排（Phase 5，ADR-025/026）。
 * 挂接 time.advance（同一事务）：对全部 implementing/issued/blocked 政策按
 * policyId 字典序结算；每政策使用派生随机流
 * seed=policy:{saveId}:{policyId}, cursor=tick×32（互不干扰、可重放，不动世界 RNG cursor）。
 * 草稿态推进模式：mutations 依序在草稿上应用，保证 before/after 全链一致。
 */

export interface PolicyStageResultRecord {
  readonly policyId: string;
  readonly saveId: string;
  readonly tick: number;
  readonly revision: number;
  readonly stageIndex: number;
  readonly fundingRatio: number;
  readonly breakdown: PolicyResolutionBreakdown;
  readonly realDelta: number;
  readonly reportedDelta: number;
  readonly ruleTrace: readonly RuleTraceEntry[];
  readonly notes: readonly string[];
}

export interface PolicyDeviationLogRecord {
  readonly policyId: string;
  readonly saveId: string;
  readonly tick: number;
  readonly revision: number;
  readonly type: TriggeredDeviation["type"];
  readonly magnitude: number;
  readonly realDeviation: string;
  readonly discovered: boolean;
}

export interface PolicyResolutionArtifacts {
  readonly stageResults: readonly PolicyStageResultRecord[];
  readonly reports: readonly PolicyReport[];
  readonly deviationLogs: readonly PolicyDeviationLogRecord[];
}

export interface PolicyResolutionResult {
  readonly mutations: readonly ProposedMutation[];
  readonly artifacts: PolicyResolutionArtifacts;
}

interface ResolutionOptions {
  readonly saveId: string;
  /** 提交后的 revision（state.revision + 1） */
  readonly commitRevision: number;
  readonly nowIso: string;
  /** 本次结算跨越的 tick 数（time.advance 的 days；维持成本与进度线性缩放） */
  readonly elapsedTicks?: number;
}

function mutation(
  input: Omit<ProposedMutation, "sourceIds" | "visibility"> &
    Partial<Pick<ProposedMutation, "sourceIds" | "visibility">>,
): ProposedMutation {
  return {
    ...input,
    sourceIds: input.sourceIds ?? [],
    visibility: input.visibility ?? "public",
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 结算内规划的效果按草稿依序应用并录制 */
class DraftRecorder {
  mutations: ProposedMutation[] = [];

  constructor(public draft: GameState) {}

  push(items: readonly ProposedMutation[]): void {
    if (items.length === 0) return;
    this.draft = applyMutations(this.draft, items);
    this.mutations.push(...items);
  }
}

export function planPolicyResolution(
  state: Readonly<GameState>,
  tick: number,
  assets: PolicyCommandAssets,
  options: ResolutionOptions,
): PolicyResolutionResult {
  const recorder = new DraftRecorder(structuredClone(state) as GameState);
  const stageResults: PolicyStageResultRecord[] = [];
  const reports: PolicyReport[] = [];
  const deviationLogs: PolicyDeviationLogRecord[] = [];

  // 1) Modifier 过期清理（留痕）
  recorder.push(planExpiredModifierCleanup(recorder.draft, tick));

  const policyIds = Object.keys(recorder.draft.policies).sort((a, b) => a.localeCompare(b));
  for (const policyId of policyIds) {
    const policy = recorder.draft.policies[policyId]!;
    if (!["issued", "implementing", "blocked"].includes(policy.status)) continue;
    const template = assets.templates.find((candidate) => candidate.id === policy.templateId);
    if (!template) continue;

    const notes: string[] = [];
    const rawRng = createDeterministicRandomSource(
      `policy:${options.saveId}:${policyId}:${fnv1a(`${options.saveId}:${policyId}`)}`,
      tick * 32,
    );
    const rng = {
      next: () => rawRng.nextFloat(),
      nextInt: (minInclusive: number, maxInclusive: number) =>
        rawRng.nextInt(minInclusive, maxInclusive),
    };
    let working: PolicyRuntimeState = structuredClone(policy) as PolicyRuntimeState;
    const truthBefore: PolicyTruth = recorder.draft.hidden.policyTruth[policyId] ?? {
      policyId,
      realStageProgress: 0,
      realOverallProgress: 0,
      corruptionAccruedTaels: 0,
      deviations: [],
    };
    let truth: PolicyTruth = structuredClone(truthBefore) as PolicyTruth;

    // 2) 维持成本：先扣政策预算，再扣国库；到位率决定资金系数
    const elapsedTicks = Math.max(1, options.elapsedTicks ?? 1);
    const upkeepTaels = (template.cost.upkeepPerTick.treasuryTaels ?? 0) * elapsedTicks;
    const upkeepGrain = (template.cost.upkeepPerTick.grainReserveShi ?? 0) * elapsedTicks;
    let fundingRatio = 1;
    let countryTaels = recorder.draft.country.treasuryTaels;
    let countryGrain = recorder.draft.country.grainReserveShi;
    let paidFromBudgetTaels = 0;
    let paidFromTreasuryTaels = 0;
    let paidFromBudgetGrain = 0;
    let paidFromTreasuryGrain = 0;
    if (upkeepTaels + upkeepGrain > 0 && policy.status !== "blocked") {
      paidFromBudgetTaels = Math.min(working.remainingBudget.treasuryTaels, upkeepTaels);
      paidFromTreasuryTaels = Math.min(countryTaels, upkeepTaels - paidFromBudgetTaels);
      paidFromBudgetGrain = Math.min(working.remainingBudget.grainReserveShi, upkeepGrain);
      paidFromTreasuryGrain = Math.min(countryGrain, upkeepGrain - paidFromBudgetGrain);
      const paid =
        paidFromBudgetTaels + paidFromTreasuryTaels + paidFromBudgetGrain + paidFromTreasuryGrain;
      const required = upkeepTaels + upkeepGrain;
      fundingRatio = required === 0 ? 1 : paid / required;
    }

    // 3) 断供 → blocked；恢复供给的 blocked → 解除
    if (policy.status === "blocked") {
      const canFund =
        working.remainingBudget.treasuryTaels + countryTaels >= upkeepTaels &&
        working.remainingBudget.grainReserveShi + countryGrain >= upkeepGrain;
      if (!canFund) {
        continue; // 维持阻滞，本 tick 不结算
      }
      working = transitionPolicy(working, { type: "policy.unblock" }).next;
      notes.push("资源恢复，解除阻滞");
    }
    if (working.status === "issued") {
      working = transitionPolicy(working, { type: "policy.begin-implementation" }).next;
      notes.push("颁行后首度结算，进入推行");
    }
    if (fundingRatio === 0) {
      working = transitionPolicy(working, {
        type: "policy.block",
        reason: "钱粮断绝，政令停摆",
      }).next;
      working = { ...working, lastResolutionTick: tick };
      recorder.push([
        mutation({
          aggregateType: "policy",
          entityId: policyId,
          operation: "set",
          path: `/policies/${policyId}`,
          before: recorder.draft.policies[policyId]!,
          after: working,
          reason: "维持成本无着，政策阻滞",
          tags: ["policy", "resolution"],
        }),
      ]);
      stageResults.push({
        policyId,
        saveId: options.saveId,
        tick,
        revision: options.commitRevision,
        stageIndex: working.currentStageIndex,
        fundingRatio: 0,
        breakdown: {
          adminFactor: 0,
          competenceFactor: 0,
          loyaltyFactor: 0,
          stressFactor: 0,
          difficultyFactor: 0,
          legitimacyFactor: 0,
          fundingFactor: 0,
          resistancePenalty: 0,
          efficiencyMultiplier: 0,
          disturbance: 0,
          coefficient: 0,
        },
        realDelta: 0,
        reportedDelta: 0,
        ruleTrace: [],
        notes: [...notes, "钱粮断绝，转入阻滞"],
      });
      continue;
    }

    // 4) 扣款 mutations（预算扣减合并入政策记录；国库出账独立留痕）
    if (paidFromTreasuryTaels > 0) {
      recorder.push([
        mutation({
          aggregateType: "country",
          operation: "decrement",
          path: "/country/treasuryTaels",
          before: countryTaels,
          after: countryTaels - paidFromTreasuryTaels,
          reason: `「${template.name}」维持银（tick ${tick}）`,
          tags: ["policy", "upkeep"],
        }),
      ]);
      countryTaels -= paidFromTreasuryTaels;
    }
    if (paidFromTreasuryGrain > 0) {
      recorder.push([
        mutation({
          aggregateType: "country",
          operation: "decrement",
          path: "/country/grainReserveShi",
          before: countryGrain,
          after: countryGrain - paidFromTreasuryGrain,
          reason: `「${template.name}」维持粮（tick ${tick}）`,
          tags: ["policy", "upkeep"],
        }),
      ]);
      countryGrain -= paidFromTreasuryGrain;
    }

    // 5) 有效值合成（Modifier 统一入口）
    const effectiveAdmin = resolveEffectiveValue(
      recorder.draft,
      { kind: "country" },
      "administrativeCapacity",
      tick,
    ).value;
    const effectiveResistance = resolveEffectiveValue(
      recorder.draft,
      { kind: "policy", policyId },
      "resistance",
      tick,
    ).value;
    const effectiveEfficiency = resolveEffectiveValue(
      recorder.draft,
      { kind: "policy", policyId },
      "executionEfficiency",
      tick,
    ).value;
    const responsibleId = working.responsibleCharacterIds[0];
    const responsibleRuntime = responsibleId ? recorder.draft.characters[responsibleId] : undefined;
    const responsibleExtra = responsibleId ? assets.characterMetrics?.[responsibleId] : undefined;
    const responsible = responsibleRuntime
      ? {
          favor: responsibleRuntime.favor,
          loyaltyToEmperor: responsibleRuntime.loyaltyToEmperor,
          stress: responsibleRuntime.stress,
          status: responsibleRuntime.status,
          ...(responsibleExtra ?? {}),
        }
      : undefined;

    // 6) 纯数学结算
    const outcome = resolvePolicyTick({
      policy: working,
      template,
      responsible,
      effectiveAdministrativeCapacity: effectiveAdmin,
      legitimacy: recorder.draft.country.legitimacy,
      effectiveResistance,
      effectiveEfficiencyMultiplier: effectiveEfficiency,
      fundingRatio,
      elapsedTicks,
      rng,
    });

    // 7) policy-resolution 作用域规则
    const contextRegionId =
      template.scope.kind === "regional" ? template.scope.regionIds[0] : undefined;
    const ruleContext: RuleEvaluationContext = {
      tick,
      country: recorder.draft.country,
      regions: recorder.draft.regions,
      flags: recorder.draft.flags,
      policy: working,
      template,
      ...(contextRegionId === undefined ? {} : { contextRegionId }),
      fundingRatio,
      resolveCharacter: (ref) => {
        const characterId = ref === "responsible" ? responsibleId : ref;
        if (!characterId) return undefined;
        const runtime = recorder.draft.characters[characterId];
        if (!runtime) return undefined;
        return {
          favor: runtime.favor,
          loyaltyToEmperor: runtime.loyaltyToEmperor,
          stress: runtime.stress,
          status: runtime.status,
          ...(assets.characterMetrics?.[characterId] ?? {}),
        };
      },
    };
    const ruleResult = evaluateRules({
      rules: assets.rules,
      scope: "policy-resolution",
      context: ruleContext,
    });
    let progressBonus = 0;
    let ruleBlockReason: string | undefined;
    const plannableEffects: RuleEffect[] = [];
    for (const effect of ruleResult.triggered.flatMap((entry) => entry.effects)) {
      if (effect.type === "advance-policy-progress") {
        progressBonus += effect.amount;
      } else if (effect.type === "set-policy-blocked") {
        ruleBlockReason = effect.reason;
      } else {
        plannableEffects.push(effect);
      }
    }
    const effectPlan = planEffectMutations(recorder.draft, plannableEffects, {
      tick,
      sourceKind: "rule",
      sourceId: `resolution:${policyId}`,
      policyId,
      ...(contextRegionId === undefined ? {} : { contextRegionId }),
      responsibleCharacterIds: working.responsibleCharacterIds,
      sourceIds: [...template.meta.sourceIds],
    });
    recorder.push(effectPlan.mutations);
    notes.push(...effectPlan.notes.map((note: EffectPlanNote) => note.note));

    // 8) 层层加码的稳定度代价
    if (outcome.overzealousStabilityCost > 0) {
      const before = recorder.draft.country.stability;
      const after = clampPercent(before - outcome.overzealousStabilityCost);
      if (after !== before) {
        recorder.push([
          mutation({
            aggregateType: "country",
            operation: "set",
            path: "/country/stability",
            before,
            after,
            reason: `「${template.name}」执行层层加码，扰累民生`,
            tags: ["policy", "deviation"],
          }),
        ]);
      }
    }

    // 9) 进度推进与阶段完成
    const stageCount = template.duration.stages.length;
    let reportedStage = working.stageProgress + outcome.reportedDelta + progressBonus;
    let realStage = truth.realStageProgress + outcome.realDelta + progressBonus;
    let stageIndex = working.currentStageIndex;
    let completedPolicy = false;
    const stage = template.duration.stages[stageIndex];
    const minFunding = stage?.successCriteria.minFundingRatio ?? 0;
    if (reportedStage >= 100 && fundingRatio >= minFunding) {
      // 阶段完成：效果落账（真实口径按 real/reported 比例折扣，表面完成留隐患）
      if (stage) {
        const discount = Math.max(0.3, Math.min(1, realStage / Math.max(1, reportedStage)));
        const scaledEffects = stage.onCompleteEffects.map((effect) =>
          "amount" in effect && typeof effect.amount === "number"
            ? {
                ...effect,
                amount:
                  Math.sign(effect.amount) *
                  Math.max(1, Math.round(Math.abs(effect.amount) * discount)),
              }
            : effect,
        ) as RuleEffect[];
        const stagePlan = planEffectMutations(recorder.draft, scaledEffects, {
          tick,
          sourceKind: "policy",
          sourceId: policyId,
          policyId,
          ...(contextRegionId === undefined ? {} : { contextRegionId }),
          responsibleCharacterIds: working.responsibleCharacterIds,
          sourceIds: [...template.meta.sourceIds],
        });
        recorder.push(stagePlan.mutations);
        notes.push(
          `阶段「${stage.title}」完成（真实折扣 ${Math.round((realStage / Math.max(1, reportedStage)) * 100)}%）`,
        );
      }
      stageIndex += 1;
      reportedStage = 0;
      realStage = 0;
      if (stageIndex >= stageCount) {
        completedPolicy = true;
      }
    }
    if (ruleBlockReason && !completedPolicy) {
      working = transitionPolicy(working, { type: "policy.block", reason: ruleBlockReason }).next;
      notes.push(`规则触发阻滞：${ruleBlockReason}`);
    }

    const reportedOverall = clampPercent(
      ((Math.min(stageIndex, stageCount) * 100 + (completedPolicy ? 0 : reportedStage)) /
        (stageCount * 100)) *
        100,
    );
    const realOverall = clampPercent(
      ((Math.min(stageIndex, stageCount) * 100 + (completedPolicy ? 0 : realStage)) /
        (stageCount * 100)) *
        100,
    );

    // 10) 完成 / 失败 / 常规推进
    if (completedPolicy) {
      const completionPlan = planEffectMutations(
        recorder.draft,
        [
          ...template.effects.completion,
          ...template.effects.longTermModifiers.map(
            (modifier) => ({ type: "add-modifier", modifier }) as RuleEffect,
          ),
        ],
        {
          tick,
          sourceKind: "policy",
          sourceId: policyId,
          policyId,
          ...(contextRegionId === undefined ? {} : { contextRegionId }),
          responsibleCharacterIds: working.responsibleCharacterIds,
          sourceIds: [...template.meta.sourceIds],
        },
      );
      recorder.push(completionPlan.mutations);
      working = transitionPolicy(working, { type: "policy.complete" }).next;
      working = { ...working, endedAtRevision: options.commitRevision };
      notes.push("全部阶段完成，政策告成");
    } else if (
      working.issuedTick !== undefined &&
      tick - working.issuedTick > template.duration.estimatedTicks * 2 &&
      reportedOverall < 50
    ) {
      const failurePlan = planEffectMutations(recorder.draft, [...template.effects.failure], {
        tick,
        sourceKind: "policy",
        sourceId: policyId,
        policyId,
        ...(contextRegionId === undefined ? {} : { contextRegionId }),
        responsibleCharacterIds: working.responsibleCharacterIds,
        sourceIds: [...template.meta.sourceIds],
      });
      recorder.push(failurePlan.mutations);
      working = transitionPolicy(working, {
        type: "policy.fail",
        reason: "逾期过甚而政不举，事败",
      }).next;
      working = { ...working, endedAtRevision: options.commitRevision };
      notes.push("超期未成，政策告败");
    }

    // 11) 政策记录与 hidden 真实档案落账
    working = {
      ...working,
      currentStageIndex: Math.min(stageIndex, stageCount - 1),
      stageProgress: completedPolicy ? 100 : clampPercent(reportedStage),
      overallProgress: completedPolicy ? 100 : reportedOverall,
      remainingBudget: {
        treasuryTaels: working.remainingBudget.treasuryTaels - paidFromBudgetTaels,
        grainReserveShi: working.remainingBudget.grainReserveShi - paidFromBudgetGrain,
      },
      investedResources: {
        treasuryTaels:
          working.investedResources.treasuryTaels + paidFromBudgetTaels + paidFromTreasuryTaels,
        grainReserveShi:
          working.investedResources.grainReserveShi + paidFromBudgetGrain + paidFromTreasuryGrain,
      },
      lastResolutionTick: tick,
    };
    truth = {
      ...truth,
      realStageProgress: completedPolicy ? 100 : clampPercent(realStage),
      realOverallProgress: completedPolicy ? clampPercent(realOverall) : realOverall,
      corruptionAccruedTaels: truth.corruptionAccruedTaels + outcome.corruptionTaels,
      deviations: [
        ...truth.deviations,
        ...outcome.deviations.map((deviation) => ({
          tick,
          type: deviation.type,
          magnitude: deviation.magnitude,
          discovered: false,
        })),
      ].slice(-20),
      ...(outcome.deviations.length > 0 ? { lastDeviationTick: tick } : {}),
    };
    recorder.push([
      mutation({
        aggregateType: "policy",
        entityId: policyId,
        operation: "set",
        path: `/policies/${policyId}`,
        before: recorder.draft.policies[policyId]!,
        after: working,
        reason: `tick ${tick} 结算`,
        tags: ["policy", "resolution"],
      }),
      mutation({
        aggregateType: "hidden",
        entityId: policyId,
        operation: recorder.draft.hidden.policyTruth[policyId] ? "set" : "add",
        path: `/hidden/policyTruth/${policyId}`,
        before: recorder.draft.hidden.policyTruth[policyId] ?? null,
        after: truth,
        reason: `tick ${tick} 真实档案`,
        visibility: "sealed",
        tags: ["policy", "truth"],
      }),
    ]);

    // 12) 明细与奏报
    stageResults.push({
      policyId,
      saveId: options.saveId,
      tick,
      revision: options.commitRevision,
      stageIndex: working.currentStageIndex,
      fundingRatio,
      breakdown: outcome.breakdown,
      realDelta: outcome.realDelta,
      reportedDelta: outcome.reportedDelta,
      ruleTrace: ruleResult.trace,
      notes,
    });
    for (const deviation of outcome.deviations) {
      deviationLogs.push({
        policyId,
        saveId: options.saveId,
        tick,
        revision: options.commitRevision,
        type: deviation.type,
        magnitude: deviation.magnitude,
        realDeviation: `roll=${deviation.roll.toFixed(4)} p=${deviation.probability.toFixed(4)}`,
        discovered: false,
      });
    }
    const stageTitle = template.duration.stages[working.currentStageIndex]?.title ?? "终局";
    reports.push(
      {
        reportId: `report_${policyId}_${tick}_public`,
        policyId,
        saveId: options.saveId,
        tick,
        revision: options.commitRevision,
        reportedStageProgress: working.stageProgress,
        reportedOverallProgress: working.overallProgress,
        stageIndex: working.currentStageIndex,
        text: renderReportText(template.name, stageTitle, working.stageProgress, "public"),
        audience: "public",
        createdAt: options.nowIso,
      },
      {
        reportId: `report_${policyId}_${tick}_hidden`,
        policyId,
        saveId: options.saveId,
        tick,
        revision: options.commitRevision,
        reportedStageProgress: working.stageProgress,
        reportedOverallProgress: working.overallProgress,
        stageIndex: working.currentStageIndex,
        text: renderReportText(
          template.name,
          stageTitle,
          working.stageProgress,
          "hidden",
          truth.realStageProgress,
        ),
        audience: "hidden",
        createdAt: options.nowIso,
      },
    );
  }

  return {
    mutations: recorder.mutations,
    artifacts: { stageResults, reports, deviationLogs },
  };
}

/** 供测试直接构造 Modifier（长期效果断言用） */
export function listPolicyModifiers(state: GameState, policyId: string): ModifierState[] {
  return Object.values(state.modifiers).filter(
    (modifier) => modifier.source.kind === "policy" && modifier.source.policyId === policyId,
  );
}
