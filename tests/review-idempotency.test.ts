import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "mandate-review-idempotency-"));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(async () => {
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  await system.service.createSave({
    saveId: "save_idem",
    scenarioId: "chongzhen-early",
    title: "Idempotency",
    seed: "idem",
  });
  return system;
}

function command(overrides: Partial<GameCommand> = {}): GameCommand {
  return {
    commandId: "cmd_idem_first",
    commandType: "country.adjust-resource",
    saveId: "save_idem",
    baseRevision: 0,
    actor: { type: "player", id: "player" },
    payload: { resource: "treasuryTaels", delta: -100, reason: "idem" },
    idempotencyKey: "same-key",
    createdAt: FIXTURE_NOW,
    ...overrides,
  } as GameCommand;
}

describe("REVIEW-005 idempotency request fingerprint", () => {
  it("marks a same-request replay idempotent and rejects a different payload using the same key", async () => {
    const system = await setup();
    const first = await system.service.commitCommand(command());
    expect(first.idempotent).toBe(false);

    const replay = await system.service.commitCommand(command({ commandId: "cmd_idem_replay" }));
    expect(replay).toMatchObject({ txId: first.txId, revision: 1, idempotent: true });

    await expect(
      system.service.commitCommand(
        command({
          commandId: "cmd_idem_conflict",
          baseRevision: 1,
          payload: { resource: "grainReserveShi", delta: -100, reason: "idem" },
        }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect((await system.service.loadState("save_idem")).revision).toBe(1);
  });

  it("rejects the same key when the actor changes", async () => {
    const system = await setup();
    await system.service.commitCommand(command());
    await expect(
      system.service.commitCommand(
        command({
          commandId: "cmd_actor_conflict",
          baseRevision: 1,
          actor: { type: "system", id: "meeting-director" },
        }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("serializes concurrent same-key requests into one execution plus one replay", async () => {
    const system = await setup();
    const [left, right] = await Promise.all([
      system.service.commitCommand(command({ commandId: "cmd_concurrent_a" })),
      system.service.commitCommand(command({ commandId: "cmd_concurrent_b" })),
    ]);
    expect(left.txId).toBe(right.txId);
    expect([left.idempotent, right.idempotent].sort()).toEqual([false, true]);
    expect((await system.service.loadState("save_idem")).revision).toBe(1);
  });

  it("allows one concurrent request and rejects a different request sharing its key", async () => {
    const system = await setup();
    const results = await Promise.allSettled([
      system.service.commitCommand(command({ commandId: "cmd_concurrent_good" })),
      system.service.commitCommand(
        command({
          commandId: "cmd_concurrent_conflict",
          payload: { resource: "grainReserveShi", delta: -100, reason: "idem" },
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "IDEMPOTENCY_KEY_CONFLICT" },
    });
    expect((await system.service.loadState("save_idem")).revision).toBe(1);
  });
});
