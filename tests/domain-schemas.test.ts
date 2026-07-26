import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEETING_RULES,
  HistoricalSourceSchema,
  MeetingRulesSchema,
  ModifierSchema,
  TemplateMetaSchema,
} from "@mandate/domain";

describe("HistoricalSourceSchema", () => {
  it("接受合法的史料来源", () => {
    const result = HistoricalSourceSchema.safeParse({
      id: "ming-shi",
      title: "明史",
      sourceType: "primary",
      reliability: "high",
    });
    expect(result.success).toBe(true);
  });

  it("拒绝非法的 reliability 取值", () => {
    const result = HistoricalSourceSchema.safeParse({
      id: "x",
      title: "x",
      sourceType: "primary",
      reliability: "very-high",
    });
    expect(result.success).toBe(false);
  });
});

describe("TemplateMetaSchema：历史模板强制标注（FR-HIST-001）", () => {
  it("sourceIds 为空时被拒绝", () => {
    const result = TemplateMetaSchema.safeParse({
      sourceIds: [],
      confirmation: "confirmed",
    });
    expect(result.success).toBe(false);
  });

  it("四类确认状态均可接受", () => {
    for (const confirmation of ["confirmed", "disputed", "inferred", "gameplay-adjusted"]) {
      const result = TemplateMetaSchema.safeParse({
        sourceIds: ["ming-shi"],
        confirmation,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("ModifierSchema（ADR-003 数据驱动规则核心）", () => {
  it("接受合法 Modifier", () => {
    const result = ModifierSchema.safeParse({
      id: "m1",
      sourceId: "policy-1",
      targetPath: "country.treasury",
      operation: "add",
      value: -50000,
    });
    expect(result.success).toBe(true);
  });

  it("拒绝非法 operation", () => {
    const result = ModifierSchema.safeParse({
      id: "m1",
      sourceId: "policy-1",
      targetPath: "country.treasury",
      operation: "hack",
      value: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("会议规则环境（FR-MEET-001）", () => {
  it("三种会议类型均有默认规则且通过 Schema 校验", () => {
    const rules = Object.values(DEFAULT_MEETING_RULES);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(MeetingRulesSchema.safeParse(rule).success).toBe(true);
    }
  });

  it("三种会议的规则参数互不相同（是不同的规则环境）", () => {
    const [court, imperial, secret] = [
      DEFAULT_MEETING_RULES.court_assembly,
      DEFAULT_MEETING_RULES.imperial_council,
      DEFAULT_MEETING_RULES.secret_council,
    ];
    expect(secret.baseLeakProbability).toBeLessThan(court.baseLeakProbability);
    expect(secret.maxParticipants).toBeLessThan(imperial.maxParticipants);
    expect(court.isPublic).toBe(true);
    expect(secret.isPublic).toBe(false);
    expect(secret.producesOfficialRecord).toBe(false);
    expect(court.legitimacyModifier).toBeGreaterThan(secret.legitimacyModifier);
  });
});
