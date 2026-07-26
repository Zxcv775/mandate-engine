import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, hashState, stableStringify } from "@mandate/game-engine";
import {
  createSaveSystem,
  migrateGameStateDocument,
  type SaveSystem,
} from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(): Promise<SaveSystem> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-integrity-"));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
  });
  cleanup.push(async () => {
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  await system.service.createSave({
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    title: "Integrity demo",
    seed: "integrity-seed",
  });
  return system;
}

async function addLog(system: SaveSystem) {
  await system.service.commitCommand({
    commandId: "cmd_integrity",
    commandType: "country.adjust-resource",
    saveId: "save_demo",
    baseRevision: 0,
    actor: { type: "system", id: "test" },
    payload: { resource: "treasuryTaels", delta: -1, reason: "test" },
    createdAt: NOW,
  });
}

describe("forward-only state migrations", () => {
  it("migrates the treasury fixture to treasuryTaels and records an immutable migration id", async () => {
    const system = await setup();
    const current = await system.service.loadState("save_demo");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 0;
    const country = legacy.country as Record<string, unknown>;
    country.treasury = country.treasuryTaels;
    delete country.treasuryTaels;

    const migrated = migrateGameStateDocument(legacy);
    expect(migrated.appliedMigrationIds).toEqual(["state-001-treasury-taels"]);
    expect(migrated.state.stateVersion).toBe(1);
    expect(migrated.state.country.treasuryTaels).toBe(current.country.treasuryTaels);
    expect(migrated.state.country).not.toHaveProperty("treasury");
  });

  it("is a no-op for the current state and rejects unknown future versions", async () => {
    const system = await setup();
    const current = await system.service.loadState("save_demo");
    expect(migrateGameStateDocument(current)).toMatchObject({ appliedMigrationIds: [] });
    expect(() => migrateGameStateDocument({ ...current, stateVersion: 99 })).toThrowError(
      expect.objectContaining({ code: "SAVE_VERSION_UNSUPPORTED" }),
    );
  });

  it("records database migration checksums exactly once", async () => {
    const system = await setup();
    const rows = system.database
      .prepare("SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id")
      .all() as Array<{ migration_id: string; checksum: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ migration_id: "001-initial-save-schema" });
    expect(rows[1]).toMatchObject({ migration_id: "002-character-memories" });
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("migrates a legacy SQLite save atomically and retains a pre-migration checkpoint", async () => {
    const system = await setup();
    const current = await system.service.loadState("save_demo");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 0;
    const country = legacy.country as Record<string, unknown>;
    country.treasury = country.treasuryTaels;
    delete country.treasuryTaels;
    system.database.exec("PRAGMA ignore_check_constraints = ON");
    system.database
      .prepare("UPDATE save_snapshots SET state_json = ?, state_hash = ? WHERE save_id = ?")
      .run(stableStringify(legacy), hashState(legacy), "save_demo");
    system.database
      .prepare("UPDATE saves SET state_version = ?, metadata_json = ? WHERE save_id = ?")
      .run(0, stableStringify({ headStateHash: hashState(legacy) }), "save_demo");
    system.database.exec("PRAGMA ignore_check_constraints = OFF");

    const result = await system.service.migrateSave("save_demo");

    expect(result).toMatchObject({
      saveId: "save_demo",
      fromVersion: 0,
      toVersion: 1,
      changed: true,
      appliedMigrationIds: ["state-001-treasury-taels"],
    });
    expect((await system.service.loadState("save_demo")).country).toMatchObject({
      treasuryTaels: current.country.treasuryTaels,
    });
    expect(await system.service.validateSave("save_demo")).toMatchObject({ valid: true });
    expect(
      system.database
        .prepare(
          "SELECT checkpoint_kind FROM save_snapshots WHERE save_id = ? AND checkpoint_kind = 'pre_migration'",
        )
        .get("save_demo"),
    ).toEqual({ checkpoint_kind: "pre_migration" });
    expect(
      system.database
        .prepare("SELECT migration_id FROM save_state_migrations WHERE save_id = ?")
        .all("save_demo"),
    ).toEqual([{ migration_id: "state-001-treasury-taels" }]);
    expect(await system.service.migrateSave("save_demo")).toMatchObject({ changed: false });
  });

  it("rolls the entire migration back when legacy state cannot be migrated", async () => {
    const system = await setup();
    const current = await system.service.loadState("save_demo");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 0;
    const country = legacy.country as Record<string, unknown>;
    country.treasury = "unknown";
    delete country.treasuryTaels;
    system.database.exec("PRAGMA ignore_check_constraints = ON");
    system.database
      .prepare("UPDATE save_snapshots SET state_json = ?, state_hash = ? WHERE save_id = ?")
      .run(stableStringify(legacy), hashState(legacy), "save_demo");
    system.database
      .prepare("UPDATE saves SET state_version = ? WHERE save_id = ?")
      .run(0, "save_demo");
    system.database.exec("PRAGMA ignore_check_constraints = OFF");

    await expect(system.service.migrateSave("save_demo")).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
    expect(
      system.database.prepare("SELECT state_version FROM saves WHERE save_id = ?").get("save_demo"),
    ).toEqual({ state_version: 0 });
    expect(
      system.database
        .prepare("SELECT COUNT(*) AS count FROM save_snapshots WHERE checkpoint_kind = 'pre_migration'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("validates state-migration checksums and preserves them in a full export", async () => {
    const source = await setup();
    const current = await source.service.loadState("save_demo");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 0;
    const country = legacy.country as Record<string, unknown>;
    country.treasury = country.treasuryTaels;
    delete country.treasuryTaels;
    source.database.exec("PRAGMA ignore_check_constraints = ON");
    source.database
      .prepare("UPDATE save_snapshots SET state_json = ?, state_hash = ? WHERE save_id = ?")
      .run(stableStringify(legacy), hashState(legacy), "save_demo");
    source.database.prepare("UPDATE saves SET state_version = ? WHERE save_id = ?").run(0, "save_demo");
    source.database.exec("PRAGMA ignore_check_constraints = OFF");
    await source.service.migrateSave("save_demo");

    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const target = await setup();
    target.database.prepare("DELETE FROM saves WHERE save_id = ?").run("save_demo");
    await target.service.importSave({ bytes: exported.bytes });
    expect(
      target.database
        .prepare("SELECT migration_id, checksum FROM save_state_migrations WHERE save_id = ?")
        .all("save_demo"),
    ).toEqual([
      expect.objectContaining({
        migration_id: "state-001-treasury-taels",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(await target.service.validateSave("save_demo")).toMatchObject({ valid: true });

    target.database
      .prepare("UPDATE save_state_migrations SET checksum = ? WHERE save_id = ?")
      .run("f".repeat(64), "save_demo");
    expect(await target.service.validateSave("save_demo")).toMatchObject({
      valid: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "STATE_MIGRATIONS", status: "failed" }),
      ]),
    });
  });
});

describe("validation and repair planning", () => {
  it("returns a structured all-passed report for a healthy save", async () => {
    const system = await setup();
    await addLog(system);
    const report = await system.service.validateSave("save_demo");
    expect(report.valid).toBe(true);
    expect(report.checks.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "SQLITE_INTEGRITY",
        "FOREIGN_KEYS",
        "MIGRATIONS",
        "REVISION_CONTINUITY",
        "SNAPSHOT_HASH",
        "LOG_HASH_CHAIN",
        "HEAD_REPLAY",
        "SOURCE_IDS",
        "PENDING_TRANSACTIONS",
        "RNG_STATE",
      ]),
    );
    expect(report.checks.every((item) => item.status === "passed")).toBe(true);
  });

  it("reports a tampered log hash instead of throwing or hiding the corruption", async () => {
    const system = await setup();
    await addLog(system);
    system.database
      .prepare("UPDATE state_change_log SET entry_hash = ? WHERE save_id = ? AND sequence = 0")
      .run("f".repeat(64), "save_demo");
    const report = await system.service.validateSave("save_demo");
    expect(report.valid).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "LOG_HASH_CHAIN", status: "failed" }),
    );
  });

  it("detects a committed transaction whose logs were removed even when a head snapshot exists", async () => {
    const system = await setup();
    await addLog(system);
    await system.service.createCheckpoint("save_demo", { kind: "manual", label: "head-anchor" });
    system.database.prepare("DELETE FROM state_change_log WHERE save_id = ?").run("save_demo");

    const report = await system.service.validateSave("save_demo");

    expect(report.valid).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "TRANSACTION_CONSISTENCY", status: "failed" }),
    );
  });

  it("reports non-contiguous log sequence independently of the hash-chain failure", async () => {
    const system = await setup();
    await addLog(system);
    system.database
      .prepare("UPDATE state_change_log SET sequence = 9 WHERE save_id = ? AND sequence = 0")
      .run("save_demo");

    const report = await system.service.validateSave("save_demo");

    expect(report.valid).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ code: "LOG_SEQUENCE", status: "failed" }),
    );
  });

  it("finds orphan pending transactions and produces a non-mutating repair plan", async () => {
    const system = await setup();
    system.database
      .prepare(
        `INSERT INTO command_transactions (
          tx_id, save_id, base_revision, target_revision, command_type, command_id,
          actor_type, actor_id, status, summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?)`,
      )
      .run("tx_pending", "save_demo", 0, 1, "time.advance", "cmd_pending", "system", "test", NOW);
    const before = system.repository.countRows();
    const plan = await system.service.repairSave("save_demo", {
      dryRun: true,
      allowHeadRebuild: true,
      allowIndexRebuild: true,
      allowSnapshotRebuild: true,
    });
    expect(plan).toMatchObject({ saveId: "save_demo", dryRun: true });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ code: "MARK_ORPHAN_PENDING_FAILED", applicable: true }),
    );
    expect(system.repository.countRows()).toEqual(before);
    expect(
      system.database.prepare("SELECT status FROM command_transactions WHERE tx_id = ?").get(
        "tx_pending",
      ),
    ).toEqual({ status: "pending" });
  });

  it("keeps repair execution disabled while the Phase 2 contract is dry-run only", async () => {
    const system = await setup();
    await expect(
      system.service.repairSave("save_demo", {
        dryRun: false,
        allowHeadRebuild: true,
        allowIndexRebuild: true,
        allowSnapshotRebuild: true,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_EXECUTION_NOT_SUPPORTED" });
  });
});
