import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, hashState, sha256Hex, stableStringify } from "@mandate/game-engine";
import {
  buildSavePackage,
  createSaveSystem,
  inspectSavePackage,
  type SaveSystem,
} from "@mandate/save-system";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(name: string): Promise<SaveSystem> {
  const directory = await mkdtemp(join(tmpdir(), `mandate-export-${name}-`));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
  });
  cleanup.push(async () => {
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  return system;
}

/** DatabaseSync.serialize 在 Node 25 被移除；backup 落盘再读字节在 24/25 均可用。 */
async function snapshotDatabaseBytes(database: DatabaseSync): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-export-bytes-"));
  try {
    const path = join(directory, "snapshot.sqlite");
    await backup(database, path);
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createAndAdvance(system: SaveSystem, seed = "export-seed") {
  await system.service.createSave({
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    title: "Export demo",
    seed,
  });
  await system.service.commitCommand({
    commandId: "cmd_common",
    commandType: "country.adjust-resource",
    saveId: "save_demo",
    baseRevision: 0,
    actor: { type: "player", id: "player" },
    payload: { resource: "treasuryTaels", delta: -100, reason: "common" },
    createdAt: NOW,
  });
}

function repack(entries: Record<string, Uint8Array>): Uint8Array {
  const manifest = entries["manifest.json"]!;
  const payload = entries["payload.sqlite"]!;
  return zipSync({
    ...entries,
    "checksums.json": strToU8(
      stableStringify({
        algorithm: "sha256",
        files: {
          "manifest.json": sha256Hex(manifest),
          "payload.sqlite": sha256Hex(payload),
        },
      }),
    ),
  });
}

describe(".mesave package", () => {
  it("exports a checked SQLite payload and imports it into an empty database", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);

    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const inspected = await inspectSavePackage(exported.bytes);
    const imported = await target.service.importSave({ bytes: exported.bytes });

    expect(exported.manifest).toMatchObject({
      saveId: "save_demo",
      headRevision: 1,
      encrypted: false,
      sourceMetadataMode: "full",
    });
    expect(inspected.entryNames.sort()).toEqual([
      "checksums.json",
      "manifest.json",
      "payload.sqlite",
    ]);
    expect(inspected.integrity).toBe("ok");
    expect(imported).toMatchObject({ result: "fast_forward", saveId: "save_demo" });
    expect(await target.service.loadState("save_demo")).toEqual(
      await source.service.loadState("save_demo"),
    );
    expect(await target.service.validateSave("save_demo")).toMatchObject({ valid: true });
  });

  it("returns noop for an identical package already imported", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);
    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    await target.service.importSave({ bytes: exported.bytes });
    const repeated = await target.service.importSave({ bytes: exported.bytes });
    expect(repeated).toMatchObject({ result: "noop", saveId: "save_demo" });
    expect((await target.service.listSaves({ includeArchived: true })).length).toBe(1);
  });

  it("fast-forwards a shared lineage when the local head is an ancestor", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);
    const revision1 = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    await target.service.importSave({ bytes: revision1.bytes });

    await source.service.commitCommand({
      commandId: "cmd_source_2",
      commandType: "time.advance",
      saveId: "save_demo",
      baseRevision: 1,
      actor: { type: "player", id: "player" },
      payload: { days: 1 },
      createdAt: NOW,
    });
    const revision2 = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const result = await target.service.importSave({ bytes: revision2.bytes });
    expect(result).toMatchObject({ result: "fast_forward", headRevision: 2 });
    expect((await target.service.loadState("save_demo")).currentDate).toBe("1627-10-03");
  });

  it("forks divergent histories instead of overwriting either world line", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);
    const common = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    await target.service.importSave({ bytes: common.bytes });
    await source.service.commitCommand({
      commandId: "cmd_source_diverge",
      commandType: "time.advance",
      saveId: "save_demo",
      baseRevision: 1,
      actor: { type: "player", id: "player" },
      payload: { days: 1 },
      createdAt: NOW,
    });
    await target.service.commitCommand({
      commandId: "cmd_target_diverge",
      commandType: "country.adjust-resource",
      saveId: "save_demo",
      baseRevision: 1,
      actor: { type: "player", id: "player" },
      payload: { resource: "grainReserveShi", delta: -1, reason: "diverge" },
      createdAt: NOW,
    });

    const divergent = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const result = await target.service.importSave({ bytes: divergent.bytes });
    expect(result).toMatchObject({ result: "forked", originalSaveId: "save_demo" });
    expect(result.saveId).not.toBe("save_demo");
    const fork = await target.service.getSave(result.saveId);
    expect(fork.parentSaveId).toBe("save_demo");
    expect(fork.lineageId).toBe((await target.service.getSave("save_demo")).lineageId);
    expect(await target.service.validateSave(result.saveId)).toMatchObject({ valid: true });
    expect(await target.service.listSaves({ includeArchived: true })).toHaveLength(2);
  });

  it("supports authenticated password encryption and hides decryption details", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);
    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
      password: "correct horse battery staple",
    });
    expect(exported.manifest.encrypted).toBe(true);
    await expect(
      target.service.importSave({ bytes: exported.bytes, password: "wrong" }),
    ).rejects.toMatchObject({ code: "SAVE_DECRYPTION_FAILED" });
    expect(
      await target.service.importSave({
        bytes: exported.bytes,
        password: "correct horse battery staple",
      }),
    ).toMatchObject({ result: "fast_forward" });
  });

  it("safe-share strips credential-like seed data and source catalog but keeps sourceIds", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source, "sk-test-secret-key");
    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const state = await target.service.loadState(imported.saveId);
    expect(exported.manifest.sourceMetadataMode).toBe("omit_catalog");
    expect(state.meta.sourceCatalogPresent).toBe(false);
    expect(state.meta.sourceIds.length).toBeGreaterThan(0);
    expect(state.rng.seed).not.toContain("sk-test-secret-key");
  });

  it.each(["strip_source_catalog", "safe_share"] as const)(
    "%s overrides includeSourceMetadata and marks the catalog omitted",
    async (safeShareMode) => {
      const source = await setup(`source-${safeShareMode}`);
      const target = await setup(`target-${safeShareMode}`);
      await createAndAdvance(source);

      const exported = await source.service.exportSave("save_demo", {
        includeSourceMetadata: true,
        safeShareMode,
      });
      const imported = await target.service.importSave({ bytes: exported.bytes });

      expect(exported.manifest).toMatchObject({
        includeSourceMetadata: false,
        sourceMetadataMode: "omit_catalog",
      });
      expect((await target.service.loadState(imported.saveId)).meta.sourceCatalogPresent).toBe(false);
    },
  );

  it("rejects a corrupted package without partial import", async () => {
    const source = await setup("source");
    const target = await setup("target");
    await createAndAdvance(source);
    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const corrupted = Uint8Array.from(exported.bytes);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await expect(target.service.importSave({ bytes: corrupted })).rejects.toMatchObject({
      code: "SAVE_PACKAGE_INVALID",
    });
    expect(await target.service.listSaves({ includeArchived: true })).toHaveLength(0);
  });

  it("automatically migrates an older state version in the temporary import payload", async () => {
    const source = await setup("legacy-source");
    const target = await setup("legacy-target");
    await source.service.createSave({
      saveId: "save_legacy",
      scenarioId: "chongzhen-early",
      title: "Legacy import",
      seed: "legacy-seed",
    });
    const current = await source.service.loadState("save_legacy");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.stateVersion = 0;
    const country = legacy.country as Record<string, unknown>;
    country.treasury = country.treasuryTaels;
    delete country.treasuryTaels;
    source.database.exec("PRAGMA ignore_check_constraints = ON");
    source.database
      .prepare("UPDATE save_snapshots SET state_json = ?, state_hash = ? WHERE save_id = ?")
      .run(stableStringify(legacy), hashState(legacy), "save_legacy");
    source.database
      .prepare("UPDATE saves SET state_version = ?, metadata_json = ? WHERE save_id = ?")
      .run(0, stableStringify({ headStateHash: hashState(legacy) }), "save_legacy");
    source.database.exec("PRAGMA ignore_check_constraints = OFF");
    const lineage = source.database
      .prepare("SELECT lineage_id FROM saves WHERE save_id = ?")
      .get("save_legacy") as { lineage_id: string };
    const bytes = buildSavePackage(
      {
        exportFormatVersion: 1,
        appVersion: "0.1.0",
        saveId: "save_legacy",
        lineageId: lineage.lineage_id,
        scenarioId: "chongzhen-early",
        dynastyId: "ming",
        schemaVersion: 1,
        stateVersion: 0,
        baseRevision: 0,
        headRevision: 0,
        exportedAt: NOW,
        includeSourceMetadata: true,
        sourceMetadataMode: "full",
        encrypted: false,
        safeShareMode: "none",
      },
      await snapshotDatabaseBytes(source.database),
    );

    const imported = await target.service.importSave({ bytes });

    expect(imported).toMatchObject({ result: "fast_forward", saveId: "save_legacy" });
    expect((await target.service.loadState("save_legacy")).stateVersion).toBe(1);
    expect(
      target.database
        .prepare("SELECT migration_id FROM save_state_migrations WHERE save_id = ?")
        .all("save_legacy"),
    ).toEqual([{ migration_id: "state-001-treasury-taels" }]);
    expect(await target.service.validateSave("save_legacy")).toMatchObject({ valid: true });
  });

  it("rejects damaged manifest/payload, unknown entries and future versions without partial writes", async () => {
    const source = await setup("invalid-source");
    await createAndAdvance(source);
    const exported = await source.service.exportSave("save_demo", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });

    const manifestEntries = unzipSync(exported.bytes);
    const manifest = JSON.parse(strFromU8(manifestEntries["manifest.json"]!)) as Record<
      string,
      unknown
    >;
    manifest.saveId = "";
    manifestEntries["manifest.json"] = strToU8(stableStringify(manifest));

    const payloadEntries = unzipSync(exported.bytes);
    payloadEntries["payload.sqlite"] = strToU8("not-a-sqlite-database");

    const extraEntries = unzipSync(exported.bytes);
    extraEntries["../unexpected.txt"] = strToU8("unexpected");

    const futureEntries = unzipSync(exported.bytes);
    const futureManifest = JSON.parse(strFromU8(futureEntries["manifest.json"]!)) as Record<
      string,
      unknown
    >;
    futureManifest.stateVersion = 99;
    futureEntries["manifest.json"] = strToU8(stableStringify(futureManifest));

    const cases = [
      ["manifest", repack(manifestEntries), "SAVE_PACKAGE_INVALID"],
      ["payload", repack(payloadEntries), "SAVE_PACKAGE_INVALID"],
      ["extra", repack(extraEntries), "SAVE_PACKAGE_INVALID"],
      ["future", repack(futureEntries), "SAVE_VERSION_UNSUPPORTED"],
    ] as const;
    for (const [name, bytes, code] of cases) {
      const target = await setup(`invalid-${name}`);
      await expect(target.service.importSave({ bytes })).rejects.toMatchObject({ code });
      expect(await target.service.listSaves({ includeArchived: true })).toHaveLength(0);
    }
  });
});
