import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, hashState, stableStringify } from "@mandate/game-engine";
import { createSaveSystem, type CommitFailureStage } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(failureInjector?: (stage: CommitFailureStage) => void) {
  const directory = await mkdtemp(join(tmpdir(), "mandate-rollback-"));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
    checkpointInterval: 50,
    ...(failureInjector ? { failureInjector } : {}),
  });
  cleanup.push(async () => {
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  await system.service.createSave({
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    title: "Rollback demo",
    seed: "rollback-seed",
  });
  return system;
}

function worldProjection(
  state: Awaited<ReturnType<ReturnType<typeof createSaveSystem>["service"]["loadState"]>>,
) {
  const { revision: _revision, meta, ...world } = state;
  const { updatedAt: _updatedAt, ...stableMeta } = meta;
  return { ...world, meta: stableMeta };
}

describe("logical rollback", () => {
  it("creates revision 4 from revision 1 while preserving revisions 2 and 3", async () => {
    const system = await setup();
    await system.service.commitCommand({
      commandId: "cmd_a",
      commandType: "country.adjust-resource",
      saveId: "save_demo",
      baseRevision: 0,
      actor: { type: "player", id: "player" },
      payload: { resource: "treasuryTaels", delta: -100, reason: "A" },
      createdAt: NOW,
    });
    const revision1 = system.repository.loadStateAtRevision("save_demo", 1);
    await system.service.commitCommand({
      commandId: "cmd_b",
      commandType: "time.advance",
      saveId: "save_demo",
      baseRevision: 1,
      actor: { type: "player", id: "player" },
      payload: { days: 2 },
      createdAt: NOW,
    });
    await system.service.commitCommand({
      commandId: "cmd_c",
      commandType: "country.adjust-resource",
      saveId: "save_demo",
      baseRevision: 2,
      actor: { type: "player", id: "player" },
      payload: { resource: "grainReserveShi", delta: -50, reason: "C" },
      createdAt: NOW,
    });

    const dryRun = await system.service.rollback("save_demo", {
      targetRevision: 1,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      dryRun: true,
      currentRevision: 3,
      targetRevision: 1,
      resultRevision: null,
    });
    expect((await system.service.loadState("save_demo")).revision).toBe(3);

    const committed = await system.service.rollback("save_demo", {
      targetRevision: 1,
      dryRun: false,
    });
    const head = await system.service.loadState("save_demo");
    const allLogs = system.repository.loadChanges("save_demo", 1);

    expect(committed).toMatchObject({
      dryRun: false,
      currentRevision: 3,
      targetRevision: 1,
      resultRevision: 4,
    });
    expect(head.revision).toBe(4);
    expect(stableStringify(worldProjection(head))).toBe(
      stableStringify(worldProjection(revision1)),
    );
    expect(system.repository.loadStateAtRevision("save_demo", 2).revision).toBe(2);
    expect(system.repository.loadStateAtRevision("save_demo", 3).revision).toBe(3);
    expect(
      allLogs
        .filter((entry) => entry.revision === 4)
        .every((entry) => entry.commandType === "save.rollback"),
    ).toBe(true);
    expect(allLogs.some((entry) => entry.tags.includes("rollback"))).toBe(true);
    expect(hashState(head)).toMatch(/^[a-f0-9]{64}$/);
    expect(await system.service.validateSave("save_demo")).toMatchObject({ valid: true });
    expect(system.repository.listCheckpoints("save_demo").some((item) => item.revision === 3)).toBe(
      true,
    );
  });

  it("rejects a target outside the retained revision range without writing", async () => {
    const system = await setup();
    const before = system.repository.countRows();
    await expect(
      system.service.rollback("save_demo", { targetRevision: 2, dryRun: false }),
    ).rejects.toMatchObject({ code: "ROLLBACK_TARGET_INVALID" });
    expect(system.repository.countRows()).toEqual(before);
  });

  it("rolls back the pre-rollback checkpoint when the logical rollback transaction fails", async () => {
    let failRollback = false;
    const system = await setup((stage) => {
      if (failRollback && stage === "after_checkpoint") {
        throw new Error("injected:rollback-checkpoint");
      }
    });
    await system.service.commitCommand({
      commandId: "cmd_before_failed_rollback",
      commandType: "country.adjust-resource",
      saveId: "save_demo",
      baseRevision: 0,
      actor: { type: "player", id: "player" },
      payload: { resource: "treasuryTaels", delta: -100, reason: "before rollback" },
      createdAt: NOW,
    });
    const before = system.repository.countRows();

    failRollback = true;
    await expect(
      system.service.rollback("save_demo", { targetRevision: 0, dryRun: false }),
    ).rejects.toThrow("injected:rollback-checkpoint");

    expect(system.repository.countRows()).toEqual(before);
    expect((await system.service.loadState("save_demo")).revision).toBe(1);
    expect(system.database.isTransaction).toBe(false);
  });
});
