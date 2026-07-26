import { describe, expect, it } from "vitest";
import {
  CharacterSchema,
  DynastySchema,
  FactionSchema,
  GameEventSchema,
  InstitutionPackSchema,
  OfficeSchema,
  RulePackSchema,
  ScenarioSchema,
  WorldbookSchema,
  toLlmVisibleGameState,
  type GameState,
} from "@mandate/domain";
import { makeCharacterTemplate } from "./helpers/character-fixtures";

const meta = {
  sourceIds: ["ming-shi"],
  confirmation: "confirmed" as const,
  notes: "测试数据",
};

describe("历史模板深度 Schema", () => {
  it("Dynasty 拒绝未知字段", () => {
    const result = DynastySchema.safeParse({
      id: "ming",
      name: "明",
      startYear: 1368,
      endYear: 1644,
      institutionPackId: "ming-standard",
      meta,
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });

  it("Scenario 校验 ISO 日期和显式原型完整度", () => {
    const base = {
      id: "scenario",
      name: "测试剧本",
      dynastyId: "ming",
      startGameDate: "1627-10-02",
      synopsis: "测试",
      initialDataRef: "data/scenarios/scenario/",
      coreCharacterIds: ["character"],
      status: "prototype",
      historicalDataCompleteness: "placeholder",
      meta,
    };

    expect(ScenarioSchema.safeParse(base).success).toBe(true);
    expect(ScenarioSchema.safeParse({ ...base, startGameDate: "1627-02-30" }).success).toBe(
      false,
    );
    expect(
      ScenarioSchema.safeParse({ ...base, historicalDataCompleteness: "unknown" }).success,
    ).toBe(false);
  });

  it("Character 使用 Phase 3 分层人物卡并校验数值范围", () => {
    const character = makeCharacterTemplate({ id: "character", name: "测试人物" });

    expect(CharacterSchema.safeParse(character).success).toBe(true);
    expect(
      CharacterSchema.safeParse({
        ...character,
        competence: { ...character.competence, military: 101 },
      }).success,
    ).toBe(false);
    expect(
      CharacterSchema.safeParse({
        ...character,
        personality: { ...character.personality, courage: -1 },
      }).success,
    ).toBe(false);
    expect(CharacterSchema.safeParse({ ...character, unknownField: true }).success).toBe(false);
  });

  it("Faction、Office 与 InstitutionPack 复用统一 Schema", () => {
    expect(
      FactionSchema.safeParse({ id: "yan-dang", name: "阉党", meta }).success,
    ).toBe(true);
    expect(
      OfficeSchema.safeParse({
        id: "shang-shu",
        name: "尚书",
        grade: 0,
        institutionId: "hu-bu",
        powers: ["主理部务"],
        quota: 1,
        meta,
      }).success,
    ).toBe(false);
    expect(
      InstitutionPackSchema.safeParse({
        id: "ming-standard",
        dynastyId: "ming",
        institutions: [
          {
            id: "hu-bu",
            name: "户部",
            type: "fiscal",
            functions: ["赋税"],
            meta,
          },
        ],
        offices: [],
        decisionStructure: "皇帝裁决，内阁票拟。",
        meta,
      }).success,
    ).toBe(true);
  });

  it("事件、规则包和 Worldbook 的嵌套 Modifier/meta 均被校验", () => {
    expect(
      GameEventSchema.safeParse({
        id: "event",
        kind: "disaster",
        trigger: { expression: "risk > 0.5" },
        effects: [
          { id: "modifier", sourceId: "event", targetPath: "country.stability", operation: "add", value: -1 },
        ],
        meta,
      }).success,
    ).toBe(true);
    expect(
      RulePackSchema.safeParse({
        packId: "rules",
        description: "测试规则",
        modifiers: [
          { id: "modifier", sourceId: "rules", targetPath: "country.stability", operation: "hack", value: -1 },
        ],
        meta,
      }).success,
    ).toBe(false);
    expect(
      WorldbookSchema.safeParse({
        id: "worldbook",
        description: "测试世界书",
        entries: [{ keys: [], content: "测试", meta }],
      }).success,
    ).toBe(false);
  });
});

describe("LLM 状态视图", () => {
  it("剥离 hidden 且不修改原对象", () => {
    const state = {
      sessionId: "session",
      currentGameDate: "1627-10-02",
      turn: 0,
      hidden: { trueLoyalty: { character: 5 }, conspiracyFlags: {}, leakAccumulators: {} },
    } as GameState;

    const visible = toLlmVisibleGameState(state);

    expect(visible).not.toHaveProperty("hidden");
    expect(state.hidden.trueLoyalty.character).toBe(5);
  });
});
