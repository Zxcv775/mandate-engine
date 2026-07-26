import {
  ModifierStateSchema,
  PolicyLifecycleStatusSchema,
  PolicyTemplateSchema,
  RulePackSchema,
  RuleSchema,
  measureConditionDepth,
  type Rule,
  type RuleCondition,
} from "@mandate/domain";
import { describe, expect, it } from "vitest";
import { migrateGameStateDocument } from "../packages/save-system/src/state-migrations";
import { makeFixtureState } from "./helpers/character-fixtures";

/** §21.1 Phase 5 Schema：政策模板 / 规则 DSL / Modifier 的合法与非法样例 + 状态迁移映射。 */

function validTemplate(): Record<string, unknown> {
  return {
    id: "policy-test",
    name: "测试政策",
    dynastyId: "ming",
    category: "relief",
    summary: "测试用赈济政策",
    objective: "赈济灾区",
    scope: { kind: "regional", regionIds: ["shaanxi"] },
    responsibleInstitutionId: "hu-bu",
    allowedOfficeIds: ["hu-bu-shang-shu"],
    cost: {
      startup: { treasuryTaels: 100_000 },
      upkeepPerTick: { treasuryTaels: 1_000 },
    },
    duration: {
      estimatedTicks: 90,
      stages: [
        {
          stageId: "stage-1",
          title: "查勘灾情",
          objective: "厘清灾区户口与灾伤分数",
          expectedTicks: 30,
          successCriteria: {},
          onCompleteEffects: [],
        },
        {
          stageId: "stage-2",
          title: "放赈",
          objective: "开仓平粜并放赈",
          expectedTicks: 60,
          successCriteria: { minFundingRatio: 0.6 },
          onCompleteEffects: [
            {
              type: "adjust-region-metric",
              region: "context",
              metric: "stability",
              amount: 5,
              reason: "赈济到位，民心稍安",
            },
          ],
        },
      ],
    },
    effects: {
      immediate: [],
      completion: [
        {
          type: "adjust-country-metric",
          metric: "stability",
          amount: 2,
          reason: "赈务底定",
        },
      ],
      failure: [],
      longTermModifiers: [],
    },
    resistance: {
      administrativeDifficulty: 45,
      affectedInterestGroups: [],
      expectedOpposition: [],
    },
    legitimacy: { baseImpact: 3, politicalCost: 5 },
    meta: {
      sourceIds: ["ming-shi", "mingshilu-chongzhen"],
      confirmation: "gameplay-adjusted",
    },
  };
}

describe("政策模板 Schema（§6.1）", () => {
  it("接受完整合法模板", () => {
    expect(PolicyTemplateSchema.safeParse(validTemplate()).success).toBe(true);
  });

  it.each([
    ["未知字段", (t: Record<string, unknown>) => ({ ...t, hacked: true })],
    [
      "重复 stageId",
      (t: Record<string, unknown>) => {
        const clone = structuredClone(t) as ReturnType<typeof validTemplate>;
        const duration = clone.duration as { stages: Array<{ stageId: string }> };
        duration.stages[1]!.stageId = duration.stages[0]!.stageId;
        return clone;
      },
    ],
    [
      "白名单外 effect",
      (t: Record<string, unknown>) => {
        const clone = structuredClone(t) as ReturnType<typeof validTemplate>;
        (clone.effects as { completion: unknown[] }).completion = [
          { type: "execute-sql", sql: "DROP TABLE saves" },
        ];
        return clone;
      },
    ],
    [
      "负启动成本",
      (t: Record<string, unknown>) => {
        const clone = structuredClone(t) as ReturnType<typeof validTemplate>;
        (clone.cost as { startup: Record<string, number> }).startup.treasuryTaels = -1;
        return clone;
      },
    ],
  ])("拒绝：%s", (_name, mutate) => {
    expect(PolicyTemplateSchema.safeParse(mutate(validTemplate())).success).toBe(false);
  });

  it("生命周期为 11 态且含终态", () => {
    expect(PolicyLifecycleStatusSchema.options).toHaveLength(11);
    for (const terminal of ["completed", "failed", "cancelled"]) {
      expect(PolicyLifecycleStatusSchema.options).toContain(terminal);
    }
  });
});

describe("规则 DSL Schema（§6.4，ADR-022）", () => {
  const validRule = (): Record<string, unknown> => ({
    id: "rule-test",
    version: 1,
    scope: "policy-resolution",
    description: "测试规则",
    priority: 10,
    condition: { op: "gte", path: "country.stability", value: 50 },
    effects: [
      {
        type: "adjust-country-metric",
        metric: "stability",
        amount: 1,
        reason: "测试",
      },
    ],
    sourceIds: [],
  });

  it("接受合法规则与规则包", () => {
    expect(RuleSchema.safeParse(validRule()).success).toBe(true);
    expect(
      RulePackSchema.safeParse({
        packId: "pack-test",
        description: "测试包",
        dslVersion: 2,
        rules: [validRule()],
        meta: { sourceIds: ["ming-shi"], confirmation: "gameplay-adjusted" },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["hidden 路径条件", { op: "eq", path: "hidden.secretFlags.x", value: 1 }],
    ["任意路径条件", { op: "eq", path: "meta.importedPackageHash", value: "x" }],
    ["rng 路径条件", { op: "gt", path: "rng.cursor", value: 0 }],
  ])("拒绝白名单外条件路径：%s", (_name, condition) => {
    expect(RuleSchema.safeParse({ ...validRule(), condition }).success).toBe(false);
  });

  it("拒绝白名单外 effect 与字符串表达式条件（旧 DSL）", () => {
    expect(
      RuleSchema.safeParse({
        ...validRule(),
        effects: [{ type: "eval", code: "process.exit(1)" }],
      }).success,
    ).toBe(false);
    expect(
      RuleSchema.safeParse({
        ...validRule(),
        condition: "country.stability >= 50",
      }).success,
    ).toBe(false);
  });

  it("条件深度炸弹被拒绝（MAX_CONDITION_DEPTH）", () => {
    let condition: RuleCondition = { op: "gte", path: "country.stability", value: 0 };
    for (let index = 0; index < 6; index++) {
      condition = { op: "not", condition };
    }
    expect(measureConditionDepth(condition)).toBeGreaterThan(5);
    expect(RuleSchema.safeParse({ ...validRule(), condition }).success).toBe(false);
  });

  it("规则包拒绝重复规则 id 与旧 v1 结构", () => {
    const rule = validRule();
    expect(
      RulePackSchema.safeParse({
        packId: "pack-dup",
        description: "重复",
        dslVersion: 2,
        rules: [rule, rule],
        meta: { sourceIds: ["ming-shi"], confirmation: "gameplay-adjusted" },
      }).success,
    ).toBe(false);
    expect(
      RulePackSchema.safeParse({
        packId: "pack-old",
        description: "旧结构",
        modifiers: [{ id: "m", sourceId: "s", targetPath: "a.b", operation: "add", value: 1 }],
        meta: { sourceIds: ["ming-shi"], confirmation: "gameplay-adjusted" },
      }).success,
    ).toBe(false);
  });
});

describe("Modifier Schema（ADR-024）", () => {
  const validModifier = (): Record<string, unknown> => ({
    modifierId: "mod-1",
    target: { kind: "country" },
    metric: "stability",
    operation: "add",
    value: -3,
    source: { kind: "policy", policyId: "policy-1" },
    effectiveTick: 10,
    expiresAtTick: 40,
    stacking: "stack",
    reason: "测试",
    sourceIds: [],
  });

  it("接受合法 Modifier（含永久）", () => {
    expect(ModifierStateSchema.safeParse(validModifier()).success).toBe(true);
    expect(ModifierStateSchema.safeParse({ ...validModifier(), expiresAtTick: null }).success).toBe(
      true,
    );
  });

  it.each([
    ["目标外指标", { target: { kind: "region", regionId: "shaanxi" }, metric: "favor" }],
    ["过期早于生效", { expiresAtTick: 5 }],
    ["未知操作", { operation: "pow" }],
  ])("拒绝：%s", (_name, overrides) => {
    expect(ModifierStateSchema.safeParse({ ...validModifier(), ...overrides }).success).toBe(false);
  });
});

describe("state-002 存档迁移（§4.6）", () => {
  it("旧 6 态政策映射为 11 态生命周期，补齐 modifiers 与 hidden.policyTruth 后可继续游玩", () => {
    const current = makeFixtureState();
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 1;
    delete legacy.modifiers;
    delete (legacy.hidden as Record<string, unknown>).policyTruth;
    (legacy.policies as Record<string, unknown>)["old-policy"] = {
      policyId: "old-policy",
      status: "executing",
      startedAtRevision: 3,
      responsibleOfficeIds: ["hu-bu-shang-shu"],
      sourceIds: ["ming-shi"],
    };

    const { state, appliedMigrationIds } = migrateGameStateDocument(legacy);
    expect(appliedMigrationIds).toEqual(["state-002-policy-lifecycle"]);
    expect(state.stateVersion).toBe(2);
    expect(state.modifiers).toEqual({});
    expect(state.hidden.policyTruth).toEqual({});
    expect(state.policies["old-policy"]).toMatchObject({
      status: "implementing",
      templateId: "old-policy",
      issuedAtRevision: 3,
      origin: { kind: "direct-decree" },
    });
  });

  it("旧状态含未知政策状态时拒绝迁移", () => {
    const legacy = structuredClone(makeFixtureState()) as unknown as Record<string, unknown>;
    legacy.stateVersion = 1;
    (legacy.policies as Record<string, unknown>).bad = {
      policyId: "bad",
      status: "mystery",
      responsibleOfficeIds: [],
      sourceIds: [],
    };
    expect(() => migrateGameStateDocument(legacy)).toThrowError(/无法迁移/);
  });
});
