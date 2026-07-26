import { z } from "zod";
import { TemplateMetaSchema } from "./common";
import { ModifierTemplateSchema } from "./modifier";
import { RuleEffectSchema } from "./rule-dsl";

/**
 * 政策领域模型（Phase 5，ADR-023）。
 * 分层：
 * - 模板（data/policies，只读、深冻结、史料标注）——本文件 PolicyTemplateSchema；
 * - 运行态（GameState.policies，经 policy.* 白名单命令变更）——PolicyRuntimeStateSchema；
 * - 真实执行态（GameState.hidden.policyTruth，仅 Debug 可见）——PolicyTruthSchema。
 * 红线：
 * - LLM 不得创建/批准/推进/废止政策；玩家可见的是奏报，真实值在 hidden；
 * - 状态转换必须走 transitionPolicy 状态机；终态不可复活。
 */

const IdSchema = z.string().trim().min(1);
const TextSchema = z.string().trim().min(1);
const NonNegativeInt = z.number().int().nonnegative();
const PercentSchema = z.number().int().min(0).max(100);

export const PolicyCategorySchema = z.enum([
  "fiscal",
  "personnel",
  "military",
  "relief",
  "ritual",
  "judicial",
  "works",
  "supervision",
]);
export type PolicyCategory = z.infer<typeof PolicyCategorySchema>;

/** 适用范围：全国 / 指定地区 / 指定机构（人群经机构与地区间接表达） */
export const PolicyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("national") }).strict(),
  z.object({ kind: z.literal("regional"), regionIds: z.array(IdSchema).min(1).max(10) }).strict(),
  z
    .object({ kind: z.literal("institutional"), institutionIds: z.array(IdSchema).min(1).max(5) })
    .strict(),
]);
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

/** 成本包：银两 / 存粮 / 行政容量占用 / 政治资本（合法性） */
export const PolicyCostBundleSchema = z
  .object({
    treasuryTaels: NonNegativeInt.optional(),
    grainReserveShi: NonNegativeInt.optional(),
    administrativeCapacity: z.number().int().min(0).max(30).optional(),
    politicalCapital: z.number().int().min(0).max(30).optional(),
  })
  .strict();
export type PolicyCostBundle = z.infer<typeof PolicyCostBundleSchema>;

export const PolicyStageSchema = z
  .object({
    stageId: IdSchema,
    title: TextSchema,
    objective: TextSchema,
    expectedTicks: z.number().int().positive().max(365),
    /** 阶段完成判据：stageProgress 达到 100 即完成；可附加最低资金到位率 */
    successCriteria: z
      .object({
        minFundingRatio: z.number().min(0).max(1).optional(),
      })
      .strict(),
    /** 阶段完成时效果（白名单） */
    onCompleteEffects: z.array(RuleEffectSchema).max(6),
  })
  .strict();
export type PolicyStage = z.infer<typeof PolicyStageSchema>;

export const PolicyTemplateSchema = z
  .object({
    id: IdSchema,
    name: TextSchema,
    dynastyId: IdSchema,
    category: PolicyCategorySchema,
    summary: TextSchema,
    objective: TextSchema,
    scope: PolicyScopeSchema,
    /** 责任机构与可指派官职要求 */
    responsibleInstitutionId: IdSchema,
    allowedOfficeIds: z.array(IdSchema).min(1).max(10),
    cost: z
      .object({
        startup: PolicyCostBundleSchema,
        upkeepPerTick: PolicyCostBundleSchema,
      })
      .strict(),
    duration: z
      .object({
        estimatedTicks: z.number().int().positive().max(3650),
        stages: z.array(PolicyStageSchema).min(1).max(8),
      })
      .strict(),
    effects: z
      .object({
        immediate: z.array(RuleEffectSchema).max(6),
        completion: z.array(RuleEffectSchema).max(6),
        failure: z.array(RuleEffectSchema).max(6),
        longTermModifiers: z.array(ModifierTemplateSchema).max(6),
      })
      .strict(),
    resistance: z
      .object({
        /** 行政难度 0-100：越高进度越慢 */
        administrativeDifficulty: PercentSchema,
        /** 涉及利益集团（派系 ID） */
        affectedInterestGroups: z.array(IdSchema).max(6),
        /** 预期反对派系 */
        expectedOpposition: z.array(IdSchema).max(6),
      })
      .strict(),
    legitimacy: z
      .object({
        /** 御批基础合法性收益/代价（正=加分） */
        baseImpact: z.number().int().min(-20).max(20),
        /** 颁行政治成本（占用政治资本） */
        politicalCost: z.number().int().min(0).max(30),
      })
      .strict(),
    meta: TemplateMetaSchema,
  })
  .strict()
  .superRefine((template, context) => {
    const stageIds = template.duration.stages.map((stage) => stage.stageId);
    if (new Set(stageIds).size !== stageIds.length) {
      context.addIssue({
        code: "custom",
        path: ["duration", "stages"],
        message: "阶段 stageId 不得重复",
      });
    }
  });
export type PolicyTemplate = z.infer<typeof PolicyTemplateSchema>;

/** 政策生命周期 11 态（ADR-023；suspended 为皇帝主动暂停，blocked 为引擎自动阻滞） */
export const PolicyLifecycleStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "issued",
  "implementing",
  "blocked",
  "partially-implemented",
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);
export type PolicyLifecycleStatus = z.infer<typeof PolicyLifecycleStatusSchema>;

export const POLICY_TERMINAL_STATUSES: readonly PolicyLifecycleStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/** 政策来源：会议裁决映射 / 皇帝直诏 */
export const PolicyOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("meeting"),
      meetingId: IdSchema,
      outcomeCandidateId: IdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("direct-decree") }).strict(),
]);
export type PolicyOrigin = z.infer<typeof PolicyOriginSchema>;

const ResourceLedgerSchema = z
  .object({
    treasuryTaels: NonNegativeInt,
    grainReserveShi: NonNegativeInt,
  })
  .strict();

/** 政策运行态（GameState.policies；Phase 5 全量替换 Phase 0 的最小占位形态） */
export const PolicyRuntimeStateSchema = z
  .object({
    policyId: IdSchema,
    templateId: IdSchema,
    status: PolicyLifecycleStatusSchema,
    createdTick: NonNegativeInt,
    issuedTick: NonNegativeInt.optional(),
    createdAtRevision: NonNegativeInt,
    approvedAtRevision: NonNegativeInt.optional(),
    issuedAtRevision: NonNegativeInt.optional(),
    endedAtRevision: NonNegativeInt.optional(),
    responsibleInstitutionId: IdSchema.optional(),
    responsibleCharacterIds: z.array(IdSchema).max(5),
    /** 当前阶段（0 起）；公开进度为玩家可见快照，可能与 hidden 真实值失真 */
    currentStageIndex: NonNegativeInt,
    stageProgress: PercentSchema,
    overallProgress: PercentSchema,
    investedResources: ResourceLedgerSchema,
    remainingBudget: ResourceLedgerSchema,
    origin: PolicyOriginSchema,
    blockedReason: TextSchema.optional(),
    suspendedReason: TextSchema.optional(),
    lastResolutionTick: NonNegativeInt.optional(),
    /** 累计合法性代价（直诏/废止等结算） */
    legitimacyCostAccrued: z.number().int().min(-100).max(100),
    sourceIds: z.array(IdSchema),
  })
  .strict();
export type PolicyRuntimeState = z.infer<typeof PolicyRuntimeStateSchema>;

/** 单次执行偏差（hidden 摘要；完整明细在 SQLite policy_deviation_log） */
export const PolicyDeviationTypeSchema = z.enum([
  "delay",
  "surface-compliance",
  "falsified-figures",
  "overzealous-execution",
  "selective-execution",
  "corruption-loss",
]);
export type PolicyDeviationType = z.infer<typeof PolicyDeviationTypeSchema>;

export const PolicyDeviationSummarySchema = z
  .object({
    tick: NonNegativeInt,
    type: PolicyDeviationTypeSchema,
    /** 偏差幅度（语义依类型：进度虚报点数/资源流失比例×100 等） */
    magnitude: z.number().int().min(0).max(100),
    discovered: z.boolean(),
  })
  .strict();
export type PolicyDeviationSummary = z.infer<typeof PolicyDeviationSummarySchema>;

/** hidden.policyTruth 条目：真实执行状态（仅 Debug API 可见；safe_share 剥离） */
export const PolicyTruthSchema = z
  .object({
    policyId: IdSchema,
    realStageProgress: PercentSchema,
    realOverallProgress: PercentSchema,
    /** 腐败累计流失（两） */
    corruptionAccruedTaels: NonNegativeInt,
    /** 最近偏差摘要（滚动上限 20 条；全量在明细表） */
    deviations: z.array(PolicyDeviationSummarySchema).max(20),
    lastDeviationTick: NonNegativeInt.optional(),
  })
  .strict();
export type PolicyTruth = z.infer<typeof PolicyTruthSchema>;

/**
 * 执行偏差配置（ADR-025）：触发概率与幅度全部数据驱动可注入；
 * 概率 = base + moralFlexibility×moralWeight − loyalty×loyaltyWeight（0..1 clamp）。
 * 默认值为设计占位（gameplay-adjusted），Phase 12 平衡。
 */
export interface PolicyDeviationTypeConfig {
  readonly baseProbability: number;
  readonly moralWeight: number;
  readonly loyaltyWeight: number;
  readonly magnitudeRange: readonly [number, number];
}

export type PolicyDeviationConfig = Readonly<
  Record<PolicyDeviationType, PolicyDeviationTypeConfig>
>;

export const DEFAULT_POLICY_DEVIATION_CONFIG: PolicyDeviationConfig = {
  delay: {
    baseProbability: 0.06,
    moralWeight: 0.001,
    loyaltyWeight: 0.0005,
    magnitudeRange: [3, 12],
  },
  "surface-compliance": {
    baseProbability: 0.04,
    moralWeight: 0.0012,
    loyaltyWeight: 0.0006,
    magnitudeRange: [20, 50],
  },
  "falsified-figures": {
    baseProbability: 0.03,
    moralWeight: 0.0015,
    loyaltyWeight: 0.0008,
    magnitudeRange: [10, 35],
  },
  "overzealous-execution": {
    baseProbability: 0.03,
    moralWeight: 0.0004,
    loyaltyWeight: -0.0004,
    magnitudeRange: [10, 30],
  },
  "selective-execution": {
    baseProbability: 0.04,
    moralWeight: 0.0008,
    loyaltyWeight: 0.0004,
    magnitudeRange: [20, 40],
  },
  "corruption-loss": {
    baseProbability: 0.05,
    moralWeight: 0.002,
    loyaltyWeight: 0.001,
    magnitudeRange: [5, 20],
  },
};

/** 单 tick 结算的系数分解（明细表与 Debug API 契约） */
export const PolicyResolutionBreakdownSchema = z
  .object({
    adminFactor: z.number(),
    competenceFactor: z.number(),
    loyaltyFactor: z.number(),
    stressFactor: z.number(),
    difficultyFactor: z.number(),
    legitimacyFactor: z.number(),
    fundingFactor: z.number(),
    resistancePenalty: z.number(),
    efficiencyMultiplier: z.number(),
    disturbance: z.number(),
    coefficient: z.number(),
  })
  .strict();
export type PolicyResolutionBreakdown = z.infer<typeof PolicyResolutionBreakdownSchema>;

/** 公开奏报（玩家可读；准确度受偏差影响） */
export const PolicyReportSchema = z
  .object({
    reportId: IdSchema,
    policyId: IdSchema,
    saveId: IdSchema,
    tick: NonNegativeInt,
    revision: NonNegativeInt,
    /** 奏报口径进度（可能失真） */
    reportedStageProgress: PercentSchema,
    reportedOverallProgress: PercentSchema,
    stageIndex: NonNegativeInt,
    /** 结构化模板文言（Phase 5 不做 LLM 叙事化） */
    text: TextSchema,
    /** hidden 真实记录（仅 Debug；safe_share 剥离该字段所在行） */
    audience: z.enum(["public", "hidden"]),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type PolicyReport = z.infer<typeof PolicyReportSchema>;
