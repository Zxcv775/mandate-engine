import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSaveCli } from "../scripts/save-cli";

const NOW = "2026-07-26T00:00:00.000Z";
const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mandate-cli-"));
  cleanup.push(directory);
  const databasePath = join(directory, "source.sqlite");
  const system = createSaveSystem({
    databasePath,
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
  });
  await system.service.createSave({
    saveId: "save_cli",
    scenarioId: "chongzhen-early",
    title: "CLI fixture",
    seed: "cli-seed",
  });
  await system.service.advanceTime("save_cli", {
    commandId: "cmd_cli_time",
    baseRevision: 0,
    days: 1,
  });
  system.close();
  return { directory, databasePath };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      writeOut: (value: string) => stdout.push(value),
      writeErr: (value: string) => stderr.push(value),
    },
  };
}

describe("save CLI", () => {
  it("checks a save by database path and emits stable JSON", async () => {
    const { databasePath } = await fixture();
    const output = capture();

    const code = await runSaveCli(["check", "--save", databasePath, "--json"], output.io);

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      ok: true,
      command: "check",
      data: { valid: true },
    });
    expect(output.stderr).toEqual([]);
  });

  it("supports rollback dry-run plus export/import through the shared service", async () => {
    const { directory, databasePath } = await fixture();
    const rollback = capture();
    expect(
      await runSaveCli(
        [
          "rollback",
          "--database",
          databasePath,
          "--save",
          "save_cli",
          "--target-revision",
          "0",
          "--dry-run",
          "--json",
        ],
        rollback.io,
      ),
    ).toBe(0);
    expect(JSON.parse(rollback.stdout.join("")).data).toMatchObject({
      dryRun: true,
      targetRevision: 0,
      resultRevision: null,
    });

    const packagePath = join(directory, "demo.mesave");
    expect(
      await runSaveCli(
        [
          "export",
          "--database",
          databasePath,
          "--save",
          "save_cli",
          "--out",
          packagePath,
          "--json",
        ],
        capture().io,
      ),
    ).toBe(0);
    expect((await readFile(packagePath)).byteLength).toBeGreaterThan(0);

    const imported = capture();
    expect(
      await runSaveCli(
        ["import", "--database", join(directory, "target.sqlite"), "--file", packagePath, "--json"],
        imported.io,
      ),
    ).toBe(0);
    expect(JSON.parse(imported.stdout.join("")).data).toMatchObject({
      result: "fast_forward",
      saveId: "save_cli",
    });
  });

  it("returns a stable non-zero error without echoing password or credential markers", async () => {
    const { directory } = await fixture();
    const output = capture();
    const secret = "DATABASE_PASSWORD=test-password";

    const code = await runSaveCli(
      ["import", "--database", join(directory, "bad.sqlite"), "--password", secret, "--json"],
      output.io,
    );

    expect(code).toBe(2);
    expect(output.stdout.join("") + output.stderr.join("")).not.toContain(secret);
    expect(JSON.parse(output.stderr.join(""))).toMatchObject({
      ok: false,
      error: { code: "CLI_ARGUMENT_INVALID" },
    });
  });
});
