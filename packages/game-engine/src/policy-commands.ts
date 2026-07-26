import type {
  GameState,
  ModifierState,
  PolicyAdjustCommand,
  PolicyApproveCommand,
  PolicyCancelCommand,
  PolicyIssueCommand,
  PolicyLifecycleStatus,
  PolicyProposeCommand,
  PolicyRejectCommand,
  PolicyResumeCommand,
  PolicyRuntimeState,
  PolicySuspendCommand,
  PolicyTemplate,
  PolicyTruth,
  ProposedMutation,
  Rule,
} from "@mandate/domain";
import {
  evaluatePolicyLegality,
  planEffectMutations,
  type RuleCharacterMetrics,
  type RuleEvaluationContext,
} from "@mandate/rule-engine";
import { StateEngineError } from "./errors";

/**
 * 政策生命周期状态机与白名单命令 planner（Phase 5，ADR-023）。
 * - transitionPolicy 为纯函数 + 完整转换矩阵；终态（completed/failed/cancelled）不可复活；
 * - 每条 policy.* 命令经 StateEngine：Zod + 引擎双重校验、恰好 revision+1、入 StateChangeLog；
 * - LLM 零状态写权限：命令只能由玩家（直诏/御批）或会议裁决映射（system:meeting-director）发起。
 */

export interface PolicyCommandAssets {
  readonly templates: readonly PolicyTemplate[];
  readonly rules: readonly Rule[];
  /** 人物卡指标（moralFlexibility/competence 等）由装配方从模板预计算 */
  readonly characterMetrics?: Readonly<
    Record<string, { moralFlexibility: number; competence: number }>
  >;
}

/** 状态机事件（引擎内部；resolution 引擎另有 begin-implementation/block/complete/fail 等） */
export type PolicyStateEvent =
  | { readonly type: "policy.submit" }
  | { readonly type: "policy.approve" }
  | { readonly type: "policy.reject"; readonly reason: string }
  | { readonly type: "policy.issue" }
  | { readonly type: "policy.begin-implementation" }
  | { readonly type: "policy.block"; readonly reason: string }
  | { readonly type: "policy.unblock" }
  | { readonly type: "policy.mark-partial"; readonly reason: string }
  | { readonly type: "policy.resume-implementation" }
  | { readonly type: "policy.suspend"; readonly reason: string }
  | { readonly type: "policy.resume"; readonly to: "issued" | "implementing" }
  | { readonly type: "policy.complete" }
  | { readonly type: "policy.fail"; readonly reason: string }
  | { readonly type: "policy.cancel"; readonly reason: string };

interface TransitionRule {
  readonly allowedFrom: readonly PolicyLifecycleStatus[];
  readonly to: PolicyLifecycleStatus | ((event: PolicyStateEvent) => PolicyLifecycleStatus);
  apply?(policy: PolicyRuntimeState & Record<string, unknown>, event: PolicyStateEvent): void;
}

const NON_TERMINAL: readonly PolicyLifecycleStatus[] = [
  "draft",
  "proposed",
  "approved",
  "issued",
  "implementing",
  "blocked",
  "partially-implemented",
  "suspended",
];

const TRANSITION_RULES: Readonly<Record<PolicyStateEvent["type"], TransitionRule>> = {
  "policy.submit": { allowedFrom: ["draft"], to: "proposed" },
  "policy.approve": { allowedFrom: ["proposed"], to: "approved" },
  "policy.reject": {
    // 无独立 rejected 态：驳回归入 cancelled 终态并留 reason（ADR-023）
    allowedFrom: ["proposed"],
    to: "cancelled",
    apply(policy, event) {
      if (event.type === "policy.reject") policy.blockedReason = event.reason;
    },
  },
  "policy.issue": { allowedFrom: ["approved"], to: "issued" },
  "policy.begin-implementation": {
    allowedFrom: ["issued"],
    to: "implementing",
    apply(policy) {
      delete policy.blockedReason;
    },
  },
  "policy.block": {
    allowedFrom: ["implementing", "partially-implemented"],
    to: "blocked",
    apply(policy, event) {
      if (event.type === "policy.block") policy.blockedReason = event.reason;
    },
  },
  "policy.unblock": {
    allowedFrom: ["blocked"],
    to: "implementing",
    apply(policy) {
      delete policy.blockedReason;
    },
  },
  "policy.mark-partial": {
    allowedFrom: ["implementing"],
    to: "partially-implemented",
    apply(policy, event) {
      if (event.type === "policy.mark-partial") policy.blockedReason = event.reason;
    },
  },
  "policy.resume-implementation": {
    allowedFrom: ["partially-implemented"],
    to: "implementing",
    apply(policy) {
      delete policy.blockedReason;
    },
  },
  "policy.suspend": {
    allowedFrom: ["issued", "implementing", "blocked", "partially-implemented"],
    to: "suspended",
    apply(policy, event) {
      if (event.type === "policy.suspend") policy.suspendedReason = event.reason;
    },
  },
  "policy.resume": {
    allowedFrom: ["suspended"],
    to: (event) => (event.type === "policy.resume" ? event.to : "implementing"),
    apply(policy) {
      delete policy.suspendedReason;
    },
  },
  "policy.complete": {
    allowedFrom: ["implementing", "partially-implemented"],
    to: "completed",
    apply(policy) {
      delete policy.blockedReason;
    },
  },
  "policy.fail": {
    allowedFrom: ["implementing", "blocked", "partially-implemented"],
    to: "failed",
    apply(policy, event) {
      if (event.type === "policy.fail") policy.blockedReason = event.reason;
    },
  },
  "policy.cancel": {
    allowedFrom: NON_TERMINAL,
    to: "cancelled",
    apply(policy, event) {
      if (event.type === "policy.cancel") policy.blockedReason = event.reason;
      delete policy.suspendedReason;
    },
  },
};

export interface PolicyTransitionResult {
  readonly next: PolicyRuntimeState;
  readonly from: PolicyLifecycleStatus;
  readonly to: PolicyLifecycleStatus;
}

export function transitionPolicy(
  policy: Readonly<PolicyRuntimeState>,
  event: PolicyStateEvent,
): PolicyTransitionResult {
  const rule = TRANSITION_RULES[event.type];
  if (!rule.allowedFrom.includes(policy.status)) {
    throw new StateEngineError(
      "POLICY_TRANSITION_INVALID",
      `政策状态 ${policy.status} 不允许 ${event.type}：${policy.policyId}`,
    );
  }
  const next = structuredClone(policy) as PolicyRuntimeState & Record<string, unknown>;
  rule.apply?.(next, event);
  next.status = typeof rule.to === "function" ? rule.to(event) : rule.to;
  return { next, from: policy.status, to: next.status };
}

/** 完整转换矩阵（文档与全矩阵测试用） */
export function describePolicyTransitionMatrix(): Readonly<
  Record<string, { allowedFrom: readonly string[]; to: string }>
> {
  return Object.fromEntries(
    Object.entries(TRANSITION_RULES).map(([event, rule]) => [
      event,
      {
        allowedFrom: rule.allowedFrom,
        to: typeof rule.to === "function" ? "issued|implementing" : rule.to,
      },
    ]),
  );
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

function requirePolicy(state: GameState, policyId: string): PolicyRuntimeState {
  const policy = state.policies[policyId];
  if (!policy) {
    throw new StateEngineError("POLICY_NOT_FOUND", `政策不存在：${policyId}`);
  }
  return policy;
}

function requireTemplate(assets: PolicyCommandAssets, templateId: string): PolicyTemplate {
  const template = assets.templates.find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new StateEngineError("POLICY_TEMPLATE_NOT_FOUND", `政策模板不存在：${templateId}`);
  }
  return template;
}

function assertNotTerminal(policy: PolicyRuntimeState): void {
  if (["completed", "failed", "cancelled"].includes(policy.status)) {
    throw new StateEngineError(
      "POLICY_ALREADY_DECIDED",
      `政策已入终态 ${policy.status}：${policy.policyId}`,
    );
  }
}

function policyRecordMutation(
  state: GameState,
  before: PolicyRuntimeState | null,
  after: PolicyRuntimeState,
  reason: string | undefined,
  sourceIds: readonly string[],
): ProposedMutation {
  return mutation({
    aggregateType: "policy",
    entityId: after.policyId,
    operation: before === null ? "add" : "set",
    path: `/policies/${after.policyId}`,
    before,
    after,
    ...(reason === undefined ? {} : { reason }),
    sourceIds: [...sourceIds],
    tags: ["policy", "lifecycle"],
  });
}

export function buildLegalityContext(
  state: GameState,
  policy: PolicyRuntimeState,
  template: PolicyTemplate,
  assets: PolicyCommandAssets,
): RuleEvaluationContext {
  const contextRegionId =
    template.scope.kind === "regional" ? template.scope.regionIds[0] : undefined;
  const resolveCharacter = (ref: string): RuleCharacterMetrics | undefined => {
    const characterId = ref === "responsible" ? policy.responsibleCharacterIds[0] : ref;
    if (!characterId) return undefined;
    const runtime = state.characters[characterId];
    if (!runtime) return undefined;
    const extra = assets.characterMetrics?.[characterId];
    return {
      favor: runtime.favor,
      loyaltyToEmperor: runtime.loyaltyToEmperor,
      stress: runtime.stress,
      status: runtime.status,
      ...(extra === undefined ? {} : extra),
    };
  };
  return {
    tick: state.tick,
    country: state.country,
    regions: state.regions,
    flags: state.flags,
    policy,
    template,
    ...(contextRegionId === undefined ? {} : { contextRegionId }),
    resolveCharacter,
  };
}

export function planPolicyPropose(
  state: GameState,
  command: PolicyProposeCommand,
  assets: PolicyCommandAssets,
): ProposedMutation[] {
  const payload = command.payload;
  if (state.policies[payload.policyId]) {
    throw new StateEngineError("POLICY_STATUS_INVALID", `政策已存在：${payload.policyId}`);
  }
  const template = requireTemplate(assets, payload.templateId);
  const record: PolicyRuntimeState = {
    policyId: payload.policyId,
    templateId: template.id,
    status: "proposed",
    createdTick: state.tick,
    createdAtRevision: state.revision + 1,
    responsibleCharacterIds: [],
    currentStageIndex: 0,
    stageProgress: 0,
    overallProgress: 0,
    investedResources: { treasuryTaels: 0, grainReserveShi: 0 },
    remainingBudget: { treasuryTaels: 0, grainReserveShi: 0 },
    origin:
      payload.origin.kind === "meeting"
        ? {
            kind: "meeting",
            meetingId: payload.origin.meetingId,
            outcomeCandidateId: payload.origin.outcomeCandidateId,
          }
        : { kind: "direct-decree" },
    legitimacyCostAccrued: 0,
    sourceIds: [...(payload.sourceIds ?? template.meta.sourceIds)],
  };
  return [
    policyRecordMutation(
      state,
      null,
      record,
      payload.reason ?? `依模板「${template.name}」立案`,
      record.sourceIds,
    ),
  ];
}

export function planPolicyApprove(
  state: GameState,
  command: PolicyApproveCommand,
  assets: PolicyCommandAssets,
): ProposedMutation[] {
  const policy = requirePolicy(state, command.payload.policyId);
  assertNotTerminal(policy);
  const template = requireTemplate(assets, policy.templateId);
  const transition = transitionPolicy(policy, { type: "policy.approve" });
  const next: PolicyRuntimeState = {
    ...transition.next,
    approvedAtRevision: state.revision + 1,
  };
  const mutations: ProposedMutation[] = [
    policyRecordMutation(state, policy, next, command.payload.reason, policy.sourceIds),
  ];

  // 合法性结算：模板基础影响 + policy-legality 规则（直诏代价数据驱动）；
  // 全部效果在同一工作副本上单次规划，避免同路径 before 冲突。
  const legality = evaluatePolicyLegality({
    rules: assets.rules,
    context: buildLegalityContext(state, policy, template, assets),
  });
  if (legality.blocked) {
    throw new StateEngineError(
      "POLICY_LEGALITY_BLOCKED",
      `御批被合法性规则阻止：${legality.blockedReason ?? "未注明缘由"}`,
    );
  }
  const combinedEffects = [
    ...(template.legitimacy.baseImpact !== 0
      ? [
          {
            type: "adjust-country-metric",
            metric: "legitimacy",
            amount: template.legitimacy.baseImpact,
            reason: `御批「${template.name}」的合法性影响`,
          } as const,
        ]
      : []),
    ...legality.effects,
  ];
  const plan = planEffectMutations(state, combinedEffects, {
    tick: state.tick,
    sourceKind: "rule",
    sourceId: `legality:${policy.policyId}`,
    policyId: policy.policyId,
    ...(template.scope.kind === "regional" && template.scope.regionIds[0] !== undefined
      ? { contextRegionId: template.scope.regionIds[0] }
      : {}),
    responsibleCharacterIds: policy.responsibleCharacterIds,
    sourceIds: [...template.meta.sourceIds],
  });
  mutations.push(...plan.mutations);
  return mutations;
}

export function planPolicyReject(
  state: GameState,
  command: PolicyRejectCommand,
): ProposedMutation[] {
  const policy = requirePolicy(state, command.payload.policyId);
  assertNotTerminal(policy);
  const transition = transitionPolicy(policy, {
    type: "policy.reject",
    reason: command.payload.reason,
  });
  const next: PolicyRuntimeState = { ...transition.next, endedAtRevision: state.revision + 1 };
  return [policyRecordMutation(state, policy, next, command.payload.reason, policy.sourceIds)];
}

export function planPolicyIssue(
  state: GameState,
  command: PolicyIssueCommand,
  assets: PolicyCommandAssets,
): ProposedMutation[] {
  const payload = command.payload;
  const policy = requirePolicy(state, payload.policyId);
  assertNotTerminal(policy);
  const template = requireTemplate(assets, policy.templateId);

  if (payload.responsibleInstitutionId !== template.responsibleInstitutionId) {
    throw new StateEngineError(
      "POLICY_ASSIGNEE_INVALID",
      `责任机构必须为模板指定的 ${template.responsibleInstitutionId}`,
    );
  }
  let holdsAllowedOffice = false;
  for (const characterId of payload.responsibleCharacterIds) {
    const character = state.characters[characterId];
    if (!character || character.status !== "active") {
      throw new StateEngineError("POLICY_ASSIGNEE_INVALID", `负责人不可用：${characterId}`);
    }
    if (character.officeId && template.allowedOfficeIds.includes(character.officeId)) {
      holdsAllowedOffice = true;
    }
  }
  if (!holdsAllowedOffice) {
    throw new StateEngineError(
      "POLICY_ASSIGNEE_INVALID",
      `至少一名负责人须任职于模板允许的官职：${template.allowedOfficeIds.join("、")}`,
    );
  }

  const startupTaels = template.cost.startup.treasuryTaels ?? 0;
  const startupGrain = template.cost.startup.grainReserveShi ?? 0;
  const additionalTaels = payload.additionalBudget?.treasuryTaels ?? 0;
  const additionalGrain = payload.additionalBudget?.grainReserveShi ?? 0;
  const totalTaels = startupTaels + additionalTaels;
  const totalGrain = startupGrain + additionalGrain;
  if (state.country.treasuryTaels < totalTaels) {
    throw new StateEngineError(
      "POLICY_COST_INSUFFICIENT",
      `国库不足：需银 ${totalTaels} 两，现存 ${state.country.treasuryTaels} 两`,
    );
  }
  if (state.country.grainReserveShi < totalGrain) {
    throw new StateEngineError(
      "POLICY_COST_INSUFFICIENT",
      `仓储不足：需粮 ${totalGrain} 石，现存 ${state.country.grainReserveShi} 石`,
    );
  }

  const transition = transitionPolicy(policy, { type: "policy.issue" });
  const next: PolicyRuntimeState = {
    ...transition.next,
    issuedTick: state.tick,
    issuedAtRevision: state.revision + 1,
    responsibleInstitutionId: payload.responsibleInstitutionId,
    responsibleCharacterIds: [...payload.responsibleCharacterIds],
    investedResources: {
      treasuryTaels: policy.investedResources.treasuryTaels + startupTaels,
      grainReserveShi: policy.investedResources.grainReserveShi + startupGrain,
    },
    remainingBudget: {
      treasuryTaels: policy.remainingBudget.treasuryTaels + additionalTaels,
      grainReserveShi: policy.remainingBudget.grainReserveShi + additionalGrain,
    },
    legitimacyCostAccrued: policy.legitimacyCostAccrued + template.legitimacy.politicalCost,
  };
  const mutations: ProposedMutation[] = [
    policyRecordMutation(
      state,
      policy,
      next,
      command.payload.reason ??
        `颁行「${template.name}」，指派 ${payload.responsibleInstitutionId}`,
      policy.sourceIds,
    ),
  ];
  if (totalTaels > 0) {
    mutations.push(
      mutation({
        aggregateType: "country",
        operation: "decrement",
        path: "/country/treasuryTaels",
        before: state.country.treasuryTaels,
        after: state.country.treasuryTaels - totalTaels,
        reason: `「${template.name}」启动银 ${startupTaels} 两 + 追加预算 ${additionalTaels} 两`,
        sourceIds: [...template.meta.sourceIds],
        tags: ["policy", "resource"],
      }),
    );
  }
  if (totalGrain > 0) {
    mutations.push(
      mutation({
        aggregateType: "country",
        operation: "decrement",
        path: "/country/grainReserveShi",
        before: state.country.grainReserveShi,
        after: state.country.grainReserveShi - totalGrain,
        reason: `「${template.name}」启动粮 ${startupGrain} 石 + 追加 ${additionalGrain} 石`,
        sourceIds: [...template.meta.sourceIds],
        tags: ["policy", "resource"],
      }),
    );
  }
  // hidden 真实执行态初始化（safe_share 剥离；Debug 可读）
  const truth: PolicyTruth = {
    policyId: policy.policyId,
    realStageProgress: 0,
    realOverallProgress: 0,
    corruptionAccruedTaels: 0,
    deviations: [],
  };
  mutations.push(
    mutation({
      aggregateType: "hidden",
      entityId: policy.policyId,
      operation: "add",
      path: `/hidden/policyTruth/${policy.policyId}`,
      before: null,
      after: truth,
      reason: `「${template.name}」真实执行档案建档`,
      visibility: "sealed",
      tags: ["policy", "truth"],
    }),
  );
  // 模板即时效果（颁行时点）在结算引擎外单独声明为立即效果时应用（M3 接入 immediate effects）
  return mutations;
}

export function planPolicyAdjust(
  state: GameState,
  command: PolicyAdjustCommand,
): ProposedMutation[] {
  const payload = command.payload;
  const policy = requirePolicy(state, payload.policyId);
  assertNotTerminal(policy);
  if (
    !["issued", "implementing", "blocked", "partially-implemented", "suspended"].includes(
      policy.status,
    )
  ) {
    throw new StateEngineError(
      "POLICY_STATUS_INVALID",
      `政策状态 ${policy.status} 不允许调整（须已颁行）`,
    );
  }
  const additionalTaels = payload.additionalBudget?.treasuryTaels ?? 0;
  const additionalGrain = payload.additionalBudget?.grainReserveShi ?? 0;
  if (state.country.treasuryTaels < additionalTaels) {
    throw new StateEngineError("POLICY_COST_INSUFFICIENT", "国库不足以追加预算");
  }
  if (state.country.grainReserveShi < additionalGrain) {
    throw new StateEngineError("POLICY_COST_INSUFFICIENT", "仓储不足以追加拨付");
  }
  if (payload.responsibleCharacterIds) {
    for (const characterId of payload.responsibleCharacterIds) {
      const character = state.characters[characterId];
      if (!character || character.status !== "active") {
        throw new StateEngineError("POLICY_ASSIGNEE_INVALID", `负责人不可用：${characterId}`);
      }
    }
  }

  let next: PolicyRuntimeState = {
    ...structuredClone(policy),
    remainingBudget: {
      treasuryTaels: policy.remainingBudget.treasuryTaels + additionalTaels,
      grainReserveShi: policy.remainingBudget.grainReserveShi + additionalGrain,
    },
    ...(payload.responsibleCharacterIds === undefined
      ? {}
      : { responsibleCharacterIds: [...payload.responsibleCharacterIds] }),
  };
  // 追加预算即时解除资源型阻滞（其余阻滞由结算判断）
  if (policy.status === "blocked" && additionalTaels + additionalGrain > 0) {
    next = transitionPolicy(next, { type: "policy.unblock" }).next;
  }
  const mutations: ProposedMutation[] = [
    policyRecordMutation(state, policy, next, payload.reason, policy.sourceIds),
  ];
  if (additionalTaels > 0) {
    mutations.push(
      mutation({
        aggregateType: "country",
        operation: "decrement",
        path: "/country/treasuryTaels",
        before: state.country.treasuryTaels,
        after: state.country.treasuryTaels - additionalTaels,
        reason: `追加预算：${payload.reason}`,
        tags: ["policy", "resource"],
      }),
    );
  }
  if (additionalGrain > 0) {
    mutations.push(
      mutation({
        aggregateType: "country",
        operation: "decrement",
        path: "/country/grainReserveShi",
        before: state.country.grainReserveShi,
        after: state.country.grainReserveShi - additionalGrain,
        reason: `追加拨付：${payload.reason}`,
        tags: ["policy", "resource"],
      }),
    );
  }
  return mutations;
}

export function planPolicySuspend(
  state: GameState,
  command: PolicySuspendCommand,
): ProposedMutation[] {
  const policy = requirePolicy(state, command.payload.policyId);
  assertNotTerminal(policy);
  const next = transitionPolicy(policy, {
    type: "policy.suspend",
    reason: command.payload.reason,
  }).next;
  return [policyRecordMutation(state, policy, next, command.payload.reason, policy.sourceIds)];
}

export function planPolicyResume(
  state: GameState,
  command: PolicyResumeCommand,
): ProposedMutation[] {
  const policy = requirePolicy(state, command.payload.policyId);
  assertNotTerminal(policy);
  const next = transitionPolicy(policy, {
    type: "policy.resume",
    to: policy.lastResolutionTick === undefined ? "issued" : "implementing",
  }).next;
  return [
    policyRecordMutation(
      state,
      policy,
      next,
      command.payload.reason ?? "圣意复行",
      policy.sourceIds,
    ),
  ];
}

export function planPolicyCancel(
  state: GameState,
  command: PolicyCancelCommand,
  assets: PolicyCommandAssets,
): ProposedMutation[] {
  const policy = requirePolicy(state, command.payload.policyId);
  assertNotTerminal(policy);
  const template = requireTemplate(assets, policy.templateId);
  const wasIssued = policy.issuedAtRevision !== undefined;
  const transition = transitionPolicy(policy, {
    type: "policy.cancel",
    reason: command.payload.reason,
  });
  const next: PolicyRuntimeState = {
    ...transition.next,
    endedAtRevision: state.revision + 1,
    remainingBudget: { treasuryTaels: 0, grainReserveShi: 0 },
  };
  const mutations: ProposedMutation[] = [
    policyRecordMutation(state, policy, next, command.payload.reason, policy.sourceIds),
  ];
  // 沉没成本结算：投入不退；未耗预算退还国库；已颁行政策废止有合法性代价（政治成本一半，向上取整）
  if (wasIssued) {
    if (policy.remainingBudget.treasuryTaels > 0) {
      mutations.push(
        mutation({
          aggregateType: "country",
          operation: "increment",
          path: "/country/treasuryTaels",
          before: state.country.treasuryTaels,
          after: state.country.treasuryTaels + policy.remainingBudget.treasuryTaels,
          reason: `废止「${template.name}」退回未耗银 ${policy.remainingBudget.treasuryTaels} 两`,
          tags: ["policy", "resource"],
        }),
      );
    }
    if (policy.remainingBudget.grainReserveShi > 0) {
      mutations.push(
        mutation({
          aggregateType: "country",
          operation: "increment",
          path: "/country/grainReserveShi",
          before: state.country.grainReserveShi,
          after: state.country.grainReserveShi + policy.remainingBudget.grainReserveShi,
          reason: `废止「${template.name}」退回未耗粮 ${policy.remainingBudget.grainReserveShi} 石`,
          tags: ["policy", "resource"],
        }),
      );
    }
    const legitimacyCost = Math.ceil(template.legitimacy.politicalCost / 2);
    if (legitimacyCost > 0) {
      const before = state.country.legitimacy;
      const after = Math.max(0, before - legitimacyCost);
      if (after !== before) {
        mutations.push(
          mutation({
            aggregateType: "country",
            operation: "set",
            path: "/country/legitimacy",
            before,
            after,
            reason: `半途废止「${template.name}」，朝令夕改有损威信`,
            tags: ["policy", "legitimacy"],
          }),
        );
      }
    }
  }
  return mutations;
}

/** Modifier 快速构造（结算/命令共用；供测试与 M3 结算引擎复用） */
export function instantiatePolicyModifier(
  policyId: string,
  template: PolicyTemplate,
  input: Omit<ModifierState, "modifierId" | "source" | "sourceIds">,
  sequence: number,
): ModifierState {
  return {
    ...input,
    modifierId: `mod_policy_${policyId}_${input.effectiveTick}_${sequence}`,
    source: { kind: "policy", policyId },
    sourceIds: [...template.meta.sourceIds],
  };
}
