import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface SaveHealthCheckResult {
  valid: boolean;
  databasePath: string;
  headRevision: number;
  rows: {
    saves: number;
    transactions: number;
    snapshots: number;
    logs: number;
  };
}

export async function runSaveHealthCheck(): Promise<SaveHealthCheckResult> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-save-check-"));
  const databasePath = join(directory, "fixture.sqlite");
  const system = createSaveSystem({
    databasePath,
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock("2026-07-26T00:00:00.000Z"),
  });
  try {
    await system.service.createSave({
      saveId: "save_health_check",
      scenarioId: "chongzhen-early",
      title: "Phase 2 health check",
      seed: "phase2-health-check-seed",
    });
    await system.service.advanceTime("save_health_check", {
      commandId: "cmd_health_time",
      baseRevision: 0,
      days: 1,
      idempotencyKey: "health-time-1",
    });
    await system.service.createCheckpoint("save_health_check", {
      kind: "manual",
      label: "phase2-health-check",
    });
    const report = await system.service.validateSave("save_health_check");
    return {
      valid: report.valid,
      databasePath,
      headRevision: (await system.service.getSave("save_health_check")).headRevision,
      rows: system.repository.countRows(),
    };
  } finally {
    system.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runSaveHealthCheck();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: "SAVE_CHECK_FAILED", message: "临时存档校验失败" } })}\n`,
    );
    process.exitCode = 1;
  }
}
