import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DataValidationError,
  ScenarioLoaderError,
  createScenarioLoader,
  validateDataDirectory,
} from "../packages/data-loader/src/index";

const projectDataRoot = resolve("data");
const temporaryRoots: string[] = [];

async function copyData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mandate-data-"));
  temporaryRoots.push(root);
  const dataRoot = join(root, "data");
  await cp(projectDataRoot, dataRoot, { recursive: true });
  return dataRoot;
}

async function updateJson(
  dataRoot: string,
  relativePath: string,
  update: (value: Record<string, unknown>) => void,
): Promise<void> {
  const file = join(dataRoot, ...relativePath.split("/"));
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  update(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("validateDataDirectory", () => {
  it("使用 Domain Schema 深度校验完整 data 目录", async () => {
    const catalog = await validateDataDirectory(projectDataRoot);

    expect(catalog.scenarios.map((scenario) => scenario.id)).toContain("chongzhen-early");
    expect(catalog.institutionPacks.map((pack) => pack.id)).toContain("ming-standard");
    expect(catalog.factions.map((faction) => faction.id)).toContain("yan-dang");
  });

  it("报告 JSON 语法错误的文件和类型", async () => {
    const dataRoot = await copyData();
    const file = join(dataRoot, "characters", "ming", "broken.json");
    await writeFile(file, "{ broken", "utf8");

    await expect(validateDataDirectory(dataRoot)).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          type: "data-json-invalid",
          file: expect.stringContaining("broken.json"),
        }),
      ],
    });
  });

  it("报告 Schema 错误的实体和字段路径", async () => {
    const dataRoot = await copyData();
    await updateJson(dataRoot, "scenarios/chongzhen-early/scenario.json", (scenario) => {
      scenario.startGameDate = "1627-02-30";
    });

    try {
      await validateDataDirectory(dataRoot);
      expect.fail("应抛出 DataValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(DataValidationError);
      expect((error as DataValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "data-schema-invalid",
            entity: "chongzhen-early",
            path: "startGameDate",
            file: expect.stringContaining("scenario.json"),
          }),
        ]),
      );
    }
  });

  it("报告缺失来源引用及 sourceIds 字段路径", async () => {
    const dataRoot = await copyData();
    await updateJson(dataRoot, "characters/ming/wei-zhongxian.json", (character) => {
      character.meta = {
        ...(character.meta as Record<string, unknown>),
        sourceIds: ["missing-source"],
      };
    });

    await expect(validateDataDirectory(dataRoot)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          type: "data-reference-invalid",
          entity: "wei-zhongxian",
          path: "meta.sourceIds[0]",
          message: expect.stringContaining("missing-source"),
        }),
      ]),
    });
  });
});

describe("ScenarioLoader", () => {
  it("从绝对 Windows 路径加载并深冻结崇祯场景包", async () => {
    const loader = createScenarioLoader({ dataRoot: projectDataRoot });
    const bundle = await loader.loadScenarioBundle("chongzhen-early");

    expect(bundle.scenario.name).toBe("崇祯初政");
    expect(bundle.dynasty.name).toBe("明");
    expect(bundle.characters.map((character) => character.id)).toContain("wei-zhongxian");
    expect(bundle.factions.map((faction) => faction.id)).toContain("yan-dang");
    expect(bundle.institutions.length).toBeGreaterThan(0);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.characters)).toBe(true);
    expect(() => {
      (bundle.characters as unknown[]).push({});
    }).toThrow();
  });

  it("支持 URL 测试夹具根目录且不依赖 cwd", async () => {
    const dataRoot = await copyData();
    const loader = createScenarioLoader({ dataRoot: pathToFileURL(`${dataRoot}/`) });

    await expect(loader.loadScenarioBundle("chongzhen-early")).resolves.toMatchObject({
      scenario: { id: "chongzhen-early" },
    });
  });

  it("未知场景返回稳定错误码", async () => {
    const loader = createScenarioLoader({ dataRoot: projectDataRoot });

    await expect(loader.loadScenarioBundle("missing")).rejects.toMatchObject({
      name: "ScenarioLoaderError",
      code: "SCENARIO_NOT_FOUND",
    } satisfies Partial<ScenarioLoaderError>);
  });

  it("clearCache 后重新读取测试数据变化", async () => {
    const dataRoot = await copyData();
    const loader = createScenarioLoader({ dataRoot });
    const first = await loader.loadScenarioBundle("chongzhen-early");
    await updateJson(dataRoot, "scenarios/chongzhen-early/scenario.json", (scenario) => {
      scenario.name = "缓存后的名称";
    });

    const cached = await loader.loadScenarioBundle("chongzhen-early");
    expect(cached).toBe(first);
    expect(cached.scenario.name).toBe("崇祯初政");

    loader.clearCache();
    const refreshed = await loader.loadScenarioBundle("chongzhen-early");
    expect(refreshed.scenario.name).toBe("缓存后的名称");
  });
});
