import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { runSaveHealthCheck } from "../scripts/check-saves";

describe("Phase 2 tooling", () => {
  it("exposes all required save and blocking quality scripts", () => {
    expect(packageJson.scripts).toMatchObject({
      "save:check": expect.any(String),
      "save:repair": expect.any(String),
      "save:rollback": expect.any(String),
      "save:export": expect.any(String),
      "save:import": expect.any(String),
      "save:migrate": expect.any(String),
      "check:saves": expect.any(String),
      "test:migrations": expect.any(String),
      "test:rollback": expect.any(String),
      "test:integrity": expect.any(String),
      "test:determinism": expect.any(String),
      "check:phase2": expect.stringContaining("test:determinism"),
    });
  });

  it("validates a disposable SQLite save without touching the development database", async () => {
    const result = await runSaveHealthCheck();
    expect(result).toMatchObject({
      valid: true,
      headRevision: 1,
      rows: { saves: 1, transactions: 1 },
    });
    expect(result.databasePath).toContain("mandate-save-check-");
  });

  it("runs the Phase 2 gates in GitHub Actions under Mock Provider", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("LLM_PROVIDER: mock");
    for (const command of [
      "npm run check:saves",
      "npm run test:migrations",
      "npm run test:rollback",
      "npm run test:integrity",
      "npm run test:determinism",
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it("documents the four accepted ADRs, implementation and required architecture diagrams", async () => {
    const adrFiles = [
      "ADR-006-save-storage-format.md",
      "ADR-007-statechangelog-design.md",
      "ADR-008-save-migration-strategy.md",
      "ADR-009-deterministic-state-engine.md",
    ];
    for (const file of adrFiles) {
      const text = await readFile(`docs/adr/${file}`, "utf8");
      for (const heading of [
        "状态",
        "背景",
        "决策",
        "选择理由",
        "替代方案",
        "缺点",
        "风险",
        "回退方案",
        "对测试的影响",
        "对兼容性的影响",
      ]) {
        expect(text).toContain(heading);
      }
    }

    const architecture = await readFile("docs/02-system-architecture.md", "utf8");
    expect(architecture).toContain("participant ENGINE as State Engine");
    expect(architecture).toContain("A[读取 Save Head]");
    expect(architecture).toContain("@mandate/save-system");
    expect(await readFile("docs/06-phase-2-implementation.md", "utf8")).toContain(
      "npm run check:phase2",
    );
    expect(await readFile("docs/05-roadmap.md", "utf8")).toContain(
      "Phase 2 · 核心状态与存档系统（已完成）",
    );
  });
});
