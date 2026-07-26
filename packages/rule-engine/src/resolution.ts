import type {
  PolicyDeviationConfig,
  PolicyDeviationType,
  PolicyResolutionBreakdown,
  PolicyRuntimeState,
  PolicyTemplate,
} from "@mandate/domain";
import { DEFAULT_POLICY_DEVIATION_CONFIG } from "@mandate/domain";
import type { RuleCharacterMetrics } from "./condition";

/**
 * 单政策单 tick 结算的纯数学（ADR-025）。
 * 本模块只做数字：系数分解、偏差判定、进度与失真计算；
 * 不读写 GameState，不产生 mutation——编排与落账在 game-engine/policy-resolution。
 * 随机数由调用方注入确定性流（fnv1a(saveId:policyId)+tick 派生，ADR-026）。
 */

export interface ResolutionRandom {
  next(): number;
  nextInt(minInclusive: number, maxInclusive: number): number;
}

export interface PolicyTickInput {
  readonly policy: PolicyRuntimeState;
  readonly template: PolicyTemplate;
  readonly responsible: RuleCharacterMetrics | undefined;
  /** 有效行政能力（0-100，已含 Modifier） */
  readonly effectiveAdministrativeCapacity: number;
  readonly legitimacy: number;
  /** 政策阻力有效值（基准 0 + Modifier） */
  readonly effectiveResistance: number;
  /** 政策执行效率乘子有效值（基准 1 + Modifier） */
  readonly effectiveEfficiencyMultiplier: number;
  /** 维持成本到位率 0..1 */
  readonly fundingRatio: number;
  /** 本次结算跨越的 tick 数（time.advance days；进度按此线性缩放） */
  readonly elapsedTicks?: number;
  readonly rng: ResolutionRandom;
  readonly deviationConfig?: PolicyDeviationConfig;
}

export interface TriggeredDeviation {
  readonly type: PolicyDeviationType;
  readonly magnitude: number;
  readonly roll: number;
  readonly probability: number;
}

export interface PolicyTickOutcome {
  readonly breakdown: PolicyResolutionBreakdown;
  /** 真实进度增量（0-100 点数） */
  readonly realDelta: number;
  /** 奏报口径进度增量（含虚报/加码等失真） */
  readonly reportedDelta: number;
  readonly deviations: readonly TriggeredDeviation[];
  /** 本 tick 腐败流失（两，基于实付维持银） */
  readonly corruptionTaels: number;
  /** 层层加码导致的国家稳定度代价 */
  readonly overzealousStabilityCost: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 偏差触发判定：确定性顺序（枚举声明序）逐一独立 roll */
export function rollDeviations(
  input: PolicyTickInput,
  config: PolicyDeviationConfig,
): TriggeredDeviation[] {
  const responsible = input.responsible;
  const moralFlexibility = responsible?.moralFlexibility ?? 50;
  const loyalty = responsible?.loyaltyToEmperor ?? 50;
  const result: TriggeredDeviation[] = [];
  for (const type of Object.keys(config) as PolicyDeviationType[]) {
    const entry = config[type];
    const probability = clamp01(
      entry.baseProbability + moralFlexibility * entry.moralWeight - loyalty * entry.loyaltyWeight,
    );
    const roll = input.rng.next();
    if (roll < probability) {
      result.push({
        type,
        magnitude: input.rng.nextInt(entry.magnitudeRange[0], entry.magnitudeRange[1]),
        roll,
        probability,
      });
    }
  }
  return result;
}

export function resolvePolicyTick(input: PolicyTickInput): PolicyTickOutcome {
  const { policy, template } = input;
  const stage = template.duration.stages[policy.currentStageIndex];
  const expectedTicks = stage?.expectedTicks ?? template.duration.estimatedTicks;

  const responsible = input.responsible;
  const adminFactor = 0.4 + (input.effectiveAdministrativeCapacity / 100) * 0.6;
  const competenceFactor = 0.5 + ((responsible?.competence ?? 50) / 100) * 0.5;
  const loyaltyFactor = 0.7 + ((responsible?.loyaltyToEmperor ?? 50) / 100) * 0.3;
  const stressFactor = (responsible?.stress ?? 0) > 70 ? 0.85 : 1;
  const difficultyFactor = 1 - template.resistance.administrativeDifficulty / 200;
  const legitimacyFactor = 0.8 + (input.legitimacy / 100) * 0.2;
  const fundingFactor = 0.5 + input.fundingRatio * 0.5;
  const resistancePenalty = clamp01(1 - Math.max(0, input.effectiveResistance) / 200);
  const efficiencyMultiplier = Math.max(0, input.effectiveEfficiencyMultiplier);
  const disturbance = 0.85 + input.rng.next() * 0.3;

  const coefficient = clamp01(
    adminFactor *
      competenceFactor *
      loyaltyFactor *
      stressFactor *
      difficultyFactor *
      legitimacyFactor *
      fundingFactor *
      resistancePenalty *
      efficiencyMultiplier,
  );

  const baseProgress = ((input.elapsedTicks ?? 1) * 100) / Math.max(1, expectedTicks);
  let realDelta = baseProgress * coefficient * disturbance;
  let reportedDelta = realDelta;
  let corruptionTaels = 0;
  let overzealousStabilityCost = 0;

  const deviations = rollDeviations(
    input,
    input.deviationConfig ?? DEFAULT_POLICY_DEVIATION_CONFIG,
  );
  for (const deviation of deviations) {
    switch (deviation.type) {
      case "delay":
        // 拖延：真实进度打折，奏报虚增
        realDelta *= 0.6;
        reportedDelta = realDelta + deviation.magnitude * 0.3;
        break;
      case "surface-compliance":
        // 表面完成：奏报全额，真实按幅度打折
        realDelta *= 1 - deviation.magnitude / 100;
        break;
      case "falsified-figures":
        // 数字造假：奏报按幅度放大
        reportedDelta = reportedDelta * (1 + deviation.magnitude / 100);
        break;
      case "overzealous-execution":
        // 层层加码：真实超额推进，代价是民生稳定
        realDelta *= 1 + deviation.magnitude / 100;
        reportedDelta = realDelta;
        overzealousStabilityCost += 1;
        break;
      case "selective-execution":
        // 选择性执行：真实仅部分落地
        realDelta *= 1 - deviation.magnitude / 200;
        break;
      case "corruption-loss": {
        // 腐败损耗：按维持银比例流失
        const upkeepTaels = template.cost.upkeepPerTick.treasuryTaels ?? 0;
        corruptionTaels += Math.round((upkeepTaels * deviation.magnitude) / 100);
        break;
      }
    }
  }

  return {
    breakdown: {
      adminFactor,
      competenceFactor,
      loyaltyFactor,
      stressFactor,
      difficultyFactor,
      legitimacyFactor,
      fundingFactor,
      resistancePenalty,
      efficiencyMultiplier,
      disturbance,
      coefficient,
    },
    realDelta,
    reportedDelta,
    deviations,
    corruptionTaels,
    overzealousStabilityCost,
  };
}

/** 奏报模板文言（Phase 5 结构化模板，不做 LLM 叙事化） */
export function renderReportText(
  templateName: string,
  stageTitle: string,
  reportedStageProgress: number,
  audience: "public" | "hidden",
  realStageProgress?: number,
): string {
  if (audience === "hidden") {
    return `【内档】「${templateName}」·${stageTitle}：奏报进度 ${reportedStageProgress}%，核实进度 ${realStageProgress ?? 0}%。`;
  }
  if (reportedStageProgress >= 100) {
    return `「${templateName}」·${stageTitle}：本阶段事竣，恭候圣裁。`;
  }
  if (reportedStageProgress >= 60) {
    return `「${templateName}」·${stageTitle}：诸务次第推行，已得十之${Math.floor(reportedStageProgress / 10)}。`;
  }
  return `「${templateName}」·${stageTitle}：正在措办，已办十之${Math.max(1, Math.floor(reportedStageProgress / 10))}。`;
}
