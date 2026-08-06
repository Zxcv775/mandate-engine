import { readFile } from "node:fs/promises";
import type { ModifierState, Rule } from "@mandate/domain";
import {
  RuleEngineError,
  applyModifierStack,
  createRuleRegistry,
  evaluateCondition,
  evaluateRules,
  planEffectMutations,
  planExpiredModifierCleanup,
  resolveConditionPath,
  resolveEffectiveValue,
  selectActiveModifiers,
  type RuleEvaluationContext,
} from "@mandate/rule-engine";
import { describe, expect, it } from "vitest";
import { makeFixtureState } from "./helpers/character-fixtures";

/** §21.4 规则引擎：条件求值、优先级顺序、Modifier 叠加顺序、clamp、trace、依赖矩阵。 */

function makeModifier(overrides: Partial<ModifierState>): ModifierState {
  return {
    modifierId: "mod-a",
    target: { kind: "country" },
    metric: "stability",
    operation: "add",
    value: 10,
    source: { kind: "system", label: "test" },
    effectiveTick: 0,
    expiresAtTick: null,
    stacking: "stack",
    reason: "测试",
    sourceIds: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: "rule-a",
    version: 1,
    scope: "policy-resolution",
    description: "测试规则",
    priority: 0,
    condition: { op: "gte", path: "country.stability", value: 0 },
    effects: [{ type: "adjust-country-metric", metric: "stability", amount: 1, reason: "测试" }],
    sourceIds: [],
    ...overrides,
  } as Rule;
}

describe("Modifier 叠加与有效值（ADR-024）", () => {
  it("应用顺序：add（id 序）→ mul → clamp-min → clamp-max", () => {
    const result = applyModifierStack(50, [
      makeModifier({ modifierId: "m3-clampmax", operation: "clamp-max", value: 70 }),
      makeModifier({ modifierId: "m2-mul", operation: "mul", value: 1.5 }),
      makeModifier({ modifierId: "m1-add", operation: "add", value: 10 }),
    ]);
    // (50 + 10) * 1.5 = 90 → clamp-max 70
    expect(result.value).toBe(70);
    expect(result.applied.map((step) => step.operation)).toEqual(["add", "mul", "clamp-max"]);
  });

  it("stack 全叠加；unique-by-source 同源同操作只取一个；replace 保留最新", () => {
    const modifiers = {
      "m-1": makeModifier({
        modifierId: "m-1",
        stacking: "unique-by-source",
        source: { kind: "policy", policyId: "p1" },
        value: 5,
      }),
      "m-2": makeModifier({
        modifierId: "m-2",
        stacking: "unique-by-source",
        source: { kind: "policy", policyId: "p1" },
        value: 99,
      }),
      "m-3": makeModifier({ modifierId: "m-3", stacking: "stack", value: 1 }),
      "m-4": makeModifier({ modifierId: "m-4", stacking: "replace", value: 7, effectiveTick: 1 }),
      "m-5": makeModifier({ modifierId: "m-5", stacking: "replace", value: 8, effectiveTick: 3 }),
    };
    const selected = selectActiveModifiers(modifiers, { kind: "country" }, "stability", 5);
    expect(selected.map((modifier) => modifier.modifierId)).toEqual(["m-1", "m-3", "m-5"]);
  });

  it("时效窗口：未生效与已过期不参与；过期清理产出留痕 mutations", () => {
    const state = makeFixtureState();
    const withModifiers = {
      ...state,
      tick: 10,
      modifiers: {
        "m-future": makeModifier({ modifierId: "m-future", effectiveTick: 20 }),
        "m-expired": makeModifier({ modifierId: "m-expired", effectiveTick: 0, expiresAtTick: 5 }),
        "m-live": makeModifier({
          modifierId: "m-live",
          effectiveTick: 0,
          expiresAtTick: 30,
          value: 4,
        }),
      },
    };
    const effective = resolveEffectiveValue(withModifiers, { kind: "country" }, "stability", 10);
    expect(effective.value).toBe(state.country.stability + 4);
    const cleanup = planExpiredModifierCleanup(withModifiers, 10);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toMatchObject({ path: "/modifiers/m-expired", operation: "remove" });
  });

  it("白名单外指标读取被拒", () => {
    const state = makeFixtureState();
    expect(() => resolveEffectiveValue(state, { kind: "country" }, "treasuryTaels")).toThrowError(
      RuleEngineError,
    );
  });
});

describe("条件求值与路径白名单（ADR-022）", () => {
  const context: RuleEvaluationContext = {
    tick: 5,
    country: makeFixtureState().country,
    regions: {},
    flags: { warTime: true },
    resolveCharacter: (ref) =>
      ref === "responsible" || ref === "wei-zhongxian"
        ? {
            favor: 25,
            loyaltyToEmperor: 20,
            stress: 30,
            status: "active",
            moralFlexibility: 80,
            competence: 70,
          }
        : undefined,
  };

  it("country/character/flags 路径求值", () => {
    expect(resolveConditionPath("country.stability", context)).toBe(45);
    expect(resolveConditionPath("character.moralFlexibility", context)).toBe(80);
    expect(resolveConditionPath("character:wei-zhongxian.favor", context)).toBe(25);
    expect(resolveConditionPath("flags.warTime", context)).toBe(true);
  });

  it("hidden 与任意路径被 RULE_CONDITION_PATH_FORBIDDEN 拒绝", () => {
    for (const path of [
      "hidden.secretFlags.x",
      "rng.cursor",
      "meta.updatedAt",
      "country.__proto__",
    ]) {
      expect(() => resolveConditionPath(path, context)).toThrowError(
        expect.objectContaining({ code: "RULE_CONDITION_PATH_FORBIDDEN" }),
      );
    }
  });

  it("and/or/not/in 组合与缺失值语义（undefined → false）", () => {
    expect(
      evaluateCondition(
        {
          op: "and",
          conditions: [
            { op: "gte", path: "country.stability", value: 40 },
            { op: "not", condition: { op: "eq", path: "flags.peace", value: true } },
            { op: "in", path: "character.status", values: ["active", "imprisoned"] },
          ],
        },
        context,
      ),
    ).toBe(true);
    // region 上下文缺失 → false 而非抛错
    expect(evaluateCondition({ op: "gt", path: "region.stability", value: 0 }, context)).toBe(
      false,
    );
  });
});

describe("解释器顺序与 trace（ADR-022）", () => {
  it("priority 降序、同分 ruleId 字典序；trace 完整记录命中与效果数", () => {
    const context: RuleEvaluationContext = {
      tick: 0,
      country: makeFixtureState().country,
      regions: {},
      flags: {},
    };
    const rules = [
      makeRule({ id: "rule-b", priority: 10 }),
      makeRule({ id: "rule-a", priority: 10 }),
      makeRule({ id: "rule-z", priority: 99 }),
      makeRule({
        id: "rule-miss",
        priority: 50,
        condition: { op: "lt", path: "country.stability", value: -1 },
      }),
    ];
    const { triggered, trace } = evaluateRules({ rules, scope: "policy-resolution", context });
    expect(trace.map((entry) => entry.ruleId)).toEqual(["rule-z", "rule-miss", "rule-a", "rule-b"]);
    expect(triggered.map((entry) => entry.rule.id)).toEqual(["rule-z", "rule-a", "rule-b"]);
    expect(trace.find((entry) => entry.ruleId === "rule-miss")).toMatchObject({
      matched: false,
      effectCount: 0,
    });
  });

  it("效果规划：资源封顶、指标 clamp、同路径顺序累计、事件候选 sealed", () => {
    const state = makeFixtureState();
    const plan = planEffectMutations(
      state,
      [
        {
          type: "adjust-country-resource",
          resource: "treasuryTaels",
          amount: -(state.country.treasuryTaels + 500),
          reason: "掏空国库",
        },
        { type: "adjust-country-metric", metric: "stability", amount: 40, reason: "第一段" },
        {
          type: "adjust-country-metric",
          metric: "stability",
          amount: 40,
          reason: "第二段（应 clamp 100）",
        },
        { type: "queue-event-candidate", eventId: "event-test-1" },
      ],
      { tick: 3, sourceKind: "system", sourceId: "test" },
    );
    const treasury = plan.mutations.find((m) => m.path === "/country/treasuryTaels");
    expect(treasury).toMatchObject({ after: 0 });
    expect(plan.notes.some((note) => note.note.includes("封顶"))).toBe(true);
    const stability = plan.mutations.filter((m) => m.path === "/country/stability");
    expect(stability).toHaveLength(2);
    expect(stability[1]).toMatchObject({ after: 100 });
    const queued = plan.mutations.find((m) => m.path === "/hidden/queuedEventIds");
    expect(queued).toMatchObject({ visibility: "sealed" });
  });

  it("政策进度效果不允许出现在通用规划（防旁路写进度）", () => {
    const state = makeFixtureState();
    expect(() =>
      planEffectMutations(
        state,
        [{ type: "advance-policy-progress", amount: 50, reason: "旁路" }],
        { tick: 0, sourceKind: "system", sourceId: "test" },
      ),
    ).toThrowError(expect.objectContaining({ code: "RULE_EFFECT_UNSUPPORTED" }));
  });

  it("remove-modifier 以 discriminated source 精确匹配，不命中相似 ID 或不同 kind", () => {
    const state = makeFixtureState();
    state.modifiers = {
      "m-p1": makeModifier({
        modifierId: "m-p1",
        source: { kind: "policy", policyId: "policy-1" },
      }),
      "m-p10": makeModifier({
        modifierId: "m-p10",
        source: { kind: "policy", policyId: "policy-10" },
      }),
      "m-event": makeModifier({
        modifierId: "m-event",
        source: { kind: "event", eventId: "policy-1" },
      }),
      "m-rule": makeModifier({
        modifierId: "m-rule",
        source: { kind: "rule", ruleId: "policy-1" },
      }),
    };
    const plan = planEffectMutations(
      state,
      [
        {
          type: "remove-modifier",
          bySource: { kind: "policy", policyId: "policy-1" },
          reason: "精确撤销",
        },
      ],
      { tick: 1, sourceKind: "system", sourceId: "test" },
    );
    expect(plan.mutations.map((item) => item.path)).toEqual(["/modifiers/m-p1"]);
  });
});

describe("规则注册表 Manifest（Snapshot 规格）", () => {
  it("跨包重复规则 id 拒绝；Manifest 排序稳定", () => {
    const packMeta = { sourceIds: ["ming-shi"], confirmation: "gameplay-adjusted" as const };
    const pack = (packId: string, ruleId: string) => ({
      packId,
      description: "测试",
      dslVersion: 2 as const,
      rules: [makeRule({ id: ruleId })],
      meta: packMeta,
    });
    const registry = createRuleRegistry([pack("pack-b", "rule-2"), pack("pack-a", "rule-1")]);
    expect(registry.manifest.map((entry) => entry.packId)).toEqual(["pack-a", "pack-b"]);
    expect(registry.byScope("policy-resolution")).toHaveLength(2);
    expect(() =>
      createRuleRegistry([pack("pack-a", "rule-1"), pack("pack-b", "rule-1")]),
    ).toThrowError(expect.objectContaining({ code: "RULE_SCHEMA_INVALID" }));
  });
});

describe("依赖矩阵红线（rule-engine 纯净性）", () => {
  it("rule-engine 不依赖 llm-adapters / agent-runtime / save-system / node:sqlite", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../packages/rule-engine/package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(packageJson.dependencies ?? {});
    for (const forbidden of [
      "@mandate/llm-adapters",
      "@mandate/agent-runtime",
      "@mandate/save-system",
      "@mandate/game-engine",
      "@mandate/meeting-engine",
    ]) {
      expect(dependencies).not.toContain(forbidden);
    }
    // 源码级守护：无 eval/new Function/Math.random/Date.now/sqlite
    const sources = [
      "errors",
      "modifier",
      "condition",
      "interpreter",
      "effects",
      "registry",
      "legality",
      "index",
    ];
    for (const name of sources) {
      const source = await readFile(
        new URL(`../packages/rule-engine/src/${name}.ts`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/\beval\s*\(/);
      expect(source).not.toMatch(/new Function/);
      expect(source).not.toMatch(/Math\.random/);
      expect(source).not.toMatch(/Date\.now|new Date\(\)/);
      expect(source).not.toMatch(/node:sqlite/);
    }
  });
});
