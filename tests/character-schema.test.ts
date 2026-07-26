import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CharacterTemplateSchema } from "@mandate/domain";
import { validateDataDirectory } from "@mandate/data-loader";
import { describe, expect, it } from "vitest";
import { makeCharacterTemplate } from "./helpers/character-fixtures";

const dataRoot = fileURLToPath(new URL("../data/", import.meta.url));

describe("人物卡 Schema（ADR-010）", () => {
  const valid = () => makeCharacterTemplate({ id: "test-character", name: "测试人物" });

  it("接受合法的分层人物模板", () => {
    expect(CharacterTemplateSchema.safeParse(valid()).success).toBe(true);
  });

  it("拒绝缺少 ID 的模板", () => {
    const { id: _id, ...rest } = valid();
    expect(CharacterTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ["courage", -1],
    ["courage", 101],
    ["suspicion", 150],
  ])("拒绝人格维度 %s=%d 越界", (dimension, value) => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        personality: { ...template.personality, [dimension]: value },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["military", -5],
    ["finance", 101],
  ])("拒绝能力维度 %s=%d 越界", (dimension, value) => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        competence: { ...template.competence, [dimension]: value },
      }).success,
    ).toBe(false);
  });

  it("拒绝未知 confirmation 取值", () => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        meta: { ...template.meta, confirmation: "definitely-true" },
      }).success,
    ).toBe(false);
  });

  it("拒绝缺少 sourceIds 的模板与经历条目", () => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        meta: { ...template.meta, sourceIds: [] },
      }).success,
    ).toBe(false);
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        historicalProfile: {
          ...template.historicalProfile,
          majorExperiences: [
            {
              title: "无来源经历",
              description: "测试",
              sourceIds: [],
              confirmation: "confirmed",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("经历必须逐条标注四类确认状态", () => {
    const template = valid();
    const withExperience = (confirmation: string) =>
      CharacterTemplateSchema.safeParse({
        ...template,
        historicalProfile: {
          ...template.historicalProfile,
          majorExperiences: [
            { title: "经历", description: "测试", sourceIds: ["ming-shi"], confirmation },
          ],
        },
      }).success;
    for (const value of ["confirmed", "disputed", "inferred", "gameplay-adjusted"]) {
      expect(withExperience(value)).toBe(true);
    }
    expect(withExperience("rumored")).toBe(false);
  });

  it("拒绝未知关键字段（strict）", () => {
    expect(CharacterTemplateSchema.safeParse({ ...valid(), hiddenPower: 9_999 }).success).toBe(
      false,
    );
  });

  it("语言风格配置校验示例语句与刻度", () => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        communication: { ...template.communication, formality: 101 },
      }).success,
    ).toBe(false);
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        communication: { ...template.communication, exampleLines: ["长".repeat(201)] },
      }).success,
    ).toBe(false);
  });

  it("非 active 开局状态不得同时持有开局官职", () => {
    const template = valid();
    expect(
      CharacterTemplateSchema.safeParse({
        ...template,
        identity: {
          ...template.identity,
          initialOfficeId: "chief-grand-secretary",
          initialRuntimeStatus: "dismissed",
        },
      }).success,
    ).toBe(false);
  });
});

describe("首批人物数据（data/characters）", () => {
  it("全部人物卡通过模板 Schema 且标注 gameplay-adjusted", async () => {
    const directory = fileURLToPath(new URL("../data/characters/ming/", import.meta.url));
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const raw = JSON.parse(await readFile(`${directory}${file}`, "utf8")) as unknown;
      const parsed = CharacterTemplateSchema.safeParse(raw);
      expect(parsed.success, `${file} 应通过人物卡 Schema`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.meta.confirmation, `${file} 必须标注 gameplay-adjusted`).toBe(
          "gameplay-adjusted",
        );
        expect(parsed.data.meta.sourceIds.length).toBeGreaterThan(0);
      }
    }
  });

  it("数据目录深度校验通过（含人物引用完整性）", async () => {
    await expect(validateDataDirectory(dataRoot)).resolves.toBeDefined();
  });

  it("袁崇焕开局去职在籍且无官职（时点约束）", async () => {
    const raw = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../data/characters/ming/yuan-chonghuan.json", import.meta.url)),
        "utf8",
      ),
    ) as { identity: { initialOfficeId: string | null; initialRuntimeStatus?: string } };
    expect(raw.identity.initialOfficeId).toBeNull();
    expect(raw.identity.initialRuntimeStatus).toBe("dismissed");
  });

  it("争议事项进入 disputedClaims 而非确定事实", async () => {
    const raw = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../data/characters/ming/yuan-chonghuan.json", import.meta.url)),
        "utf8",
      ),
    ) as { historicalProfile: { disputedClaims: string[] } };
    expect(raw.historicalProfile.disputedClaims.length).toBeGreaterThan(0);
  });
});
