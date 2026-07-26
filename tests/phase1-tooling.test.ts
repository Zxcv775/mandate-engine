import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("Phase 1 根脚本", () => {
  it("固定单一 Node/npm 工具链并提供完整检查入口", async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
      packageManager: string;
      scripts: Record<string, string>;
    };

    expect((await readFile(new URL(".nvmrc", root), "utf8")).trim()).toBe("24.18.0");
    expect(packageJson.packageManager).toBe("npm@11.16.0");
    expect(packageJson.scripts).toMatchObject({
      dev: expect.stringContaining("concurrently"),
      "test:watch": "vitest",
      check: "npm run lint && npm run typecheck && npm test && npm run build && npm run check:data",
    });
  });
});

describe("GitHub Actions", () => {
  it("在 main push 与 PR 上以 Mock Provider 顺序执行六道门禁", async () => {
    // checkout 可能按 autocrlf 产出 CRLF，断言前统一为 LF
    const workflow = (await readFile(new URL(".github/workflows/ci.yml", root), "utf8")).replace(
      /\r\n/g,
      "\n",
    );

    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toContain("LLM_PROVIDER: mock");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toMatch(/push:[\s\S]*branches:[\s\S]*- main/);
    expect(workflow).toContain("pull_request:");

    const commands = [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run check:data",
    ];
    const positions = commands.map((command) => workflow.indexOf(`run: ${command}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});
