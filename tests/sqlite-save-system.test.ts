import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, SaveSystemError } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T00:00:00.000Z";
const resources: Array<{ close(): void; directory: string }> = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    resource?.close();
    if (resource) await rm(resource.directory, { recursive: true, force: true });
  }
});

async function setup(
  options: {
    failureStage?: "after_transaction" | "after_logs" | "after_head" | "after_checkpoint";
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "mandate-save-test-"));
  const system = createSaveSystem({
    databasePath: join(directory, "saves.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
    checkpointInterval: 2,
    failureInjector: options.failureStage
      ? (stage) => {
          if (stage === options.failureStage) throw new Error(`injected:${stage}`);
        }
      : undefined,
  });
  resources.push({ close: () => system.close(), directory });
  return { ...system, directory };
}

async function createDemo(system: Awaited<ReturnType<typeof setup>>) {
  return system.service.createSave({
    scenarioId: "chongzhen-early",
    title: "崇祯元年开局",
    seed: "demo-seed",
    saveId: "save_demo",
  });
}

function adjustCommand(baseRevision: number, idempotencyKey?: string): GameCommand {
  return {
    commandId: `cmd_adjust_${baseRevision}`,
    commandType: "country.adjust-resource",
    saveId: "save_demo",
    baseRevision,
    actor: { type: "player", id: "player" },
    payload: {
      resource: "treasuryTaels",
      delta: -300_000,
      reason: "辽饷首拨",
    },
    ...(idempotencyKey ? { idempotencyKey } : {}),
    createdAt: NOW,
  };
}

describe("SQLite save schema", () => {
  it("enables defensive pragmas and applies STRICT migrations", async () => {
    const system = await setup();
    const foreignKeys = system.database.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    const journalMode = system.database.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    const tables = system.database
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;

    expect(foreignKeys.foreign_keys).toBe(1);
    expect(journalMode.journal_mode.toLowerCase()).toBe("wal");
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "saves",
        "command_transactions",
        "save_snapshots",
        "state_change_log",
        "schema_migrations",
        "save_state_migrations",
        "import_history",
      ]),
    );
    expect(tables.find((table) => table.name === "saves")?.sql).toContain("STRICT");
  });

  it("enforces foreign keys", async () => {
    const system = await setup();
    expect(() =>
      system.database
        .prepare(
          "INSERT INTO save_snapshots (snapshot_id, save_id, revision, checkpoint_kind, label, state_json, state_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("snapshot_bad", "missing", 0, "initial", null, "{}", "a".repeat(64), NOW),
    ).toThrow();
  });
});

describe("Save application service", () => {
  it("creates, lists, and loads a revision 0 save with an initial checkpoint", async () => {
    const system = await setup();
    const created = await createDemo(system);
    const listed = await system.service.listSaves();
    const state = await system.service.loadState("save_demo");
    const checkpoints = system.repository.listCheckpoints("save_demo");

    expect(created).toMatchObject({
      saveId: "save_demo",
      scenarioId: "chongzhen-early",
      dynastyId: "ming",
      status: "active",
      headRevision: 0,
      currentDate: "1627-10-02",
      snapshotCount: 1,
    });
    expect(listed).toHaveLength(1);
    expect(state).toMatchObject({ saveId: "save_demo", revision: 0, tick: 0 });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.kind).toBe("initial");
    expect(await system.service.validateSave("save_demo")).toMatchObject({ valid: true });
  });

  it("commits state, logs, head, and periodic checkpoint atomically", async () => {
    const system = await setup();
    await createDemo(system);

    const first = await system.service.commitCommand(adjustCommand(0));
    const second = await system.service.commitCommand({
      commandId: "cmd_time_1",
      commandType: "time.advance",
      saveId: "save_demo",
      baseRevision: 1,
      actor: { type: "player", id: "player" },
      payload: { days: 1 },
      createdAt: NOW,
    });
    const loaded = await system.service.loadState("save_demo");
    const changes = system.repository.loadChanges("save_demo", 1);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(loaded.country.treasuryTaels).toBe(3_900_000);
    expect(loaded.currentDate).toBe("1627-10-03");
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(changes[0]?.prevLogHash).toBeNull();
    for (let index = 1; index < changes.length; index += 1) {
      expect(changes[index]?.prevLogHash).toBe(changes[index - 1]?.entryHash);
    }
    expect(system.repository.listCheckpoints("save_demo").map((item) => item.revision)).toEqual([
      0, 2,
    ]);
  });

  it("returns the prior result for a repeated idempotency key", async () => {
    const system = await setup();
    await createDemo(system);
    const first = await system.service.commitCommand(adjustCommand(0, "idem_demo"));
    const repeated = await system.service.commitCommand(adjustCommand(0, "idem_demo"));
    expect(repeated).toEqual(first);
    expect((await system.service.loadState("save_demo")).revision).toBe(1);
  });

  it("rejects revision conflicts without opening a write transaction", async () => {
    const system = await setup();
    await createDemo(system);
    const before = system.repository.countRows();
    await expect(system.service.commitCommand(adjustCommand(3))).rejects.toMatchObject({
      code: "STATE_REVISION_CONFLICT",
    });
    expect(system.repository.countRows()).toEqual(before);
    expect(system.database.isTransaction).toBe(false);
  });

  it.each(["after_transaction", "after_logs", "after_head", "after_checkpoint"] as const)(
    "rolls back every write when failure is injected at %s",
    async (failureStage) => {
      const system = await setup({ failureStage });
      await createDemo(system);
      const before = system.repository.countRows();
      await expect(system.service.commitCommand(adjustCommand(0))).rejects.toThrow(
        `injected:${failureStage}`,
      );
      expect(system.repository.countRows()).toEqual(before);
      expect((await system.service.loadState("save_demo")).revision).toBe(0);
      expect(system.database.isTransaction).toBe(false);
      expect(system.database.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    },
  );

  it("creates a manual checkpoint without changing world revision", async () => {
    const system = await setup();
    await createDemo(system);
    await system.service.commitCommand(adjustCommand(0));
    const checkpoint = await system.service.createCheckpoint("save_demo", {
      kind: "manual",
      label: "处理辽饷之前",
    });
    expect(checkpoint).toMatchObject({ revision: 1, kind: "manual", label: "处理辽饷之前" });
    expect((await system.service.loadState("save_demo")).revision).toBe(1);
  });

  it("archives a save and excludes it from the default active list", async () => {
    const system = await setup();
    await createDemo(system);
    await system.service.archiveSave("save_demo");
    expect(await system.service.listSaves()).toHaveLength(0);
    expect(await system.service.listSaves({ includeArchived: true })).toMatchObject([
      { saveId: "save_demo", status: "archived" },
    ]);
  });

  it("returns a stable SAVE_NOT_FOUND error", async () => {
    const system = await setup();
    await expect(system.service.loadState("missing")).rejects.toEqual(
      expect.objectContaining<Partial<SaveSystemError>>({ code: "SAVE_NOT_FOUND" }),
    );
  });
});
