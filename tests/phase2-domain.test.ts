import {
  GameCommandSchema,
  GameStateSchema,
  ProposedMutationSchema,
  SaveExportManifestSchema,
  StateChangeLogEntrySchema,
  toPlayerStateView,
  type GameState,
} from "@mandate/domain";
import { describe, expect, it } from "vitest";

function validState(): GameState {
  return {
    schemaVersion: 1,
    stateVersion: 1,
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    dynastyId: "ming",
    revision: 0,
    tick: 0,
    currentDate: "1627-10-02",
    rng: { seed: "demo-seed", cursor: 0 },
    country: {
      treasuryTaels: 4_200_000,
      grainReserveShi: 2_000_000,
      legitimacy: 70,
      stability: 45,
      administrativeCapacity: 55,
      militaryReadiness: 40,
      sourceIds: ["ming-shi"],
    },
    characters: {
      "wei-zhongxian": {
        characterId: "wei-zhongxian",
        status: "active",
        officeId: null,
        favor: 25,
        loyaltyToEmperor: 20,
        stress: 30,
        lastUpdatedRevision: 0,
        sourceIds: ["ming-shi"],
      },
    },
    offices: {},
    policies: {},
    regions: {},
    meetings: {},
    modifiers: {},
    eventQueue: { pendingEventIds: [], processedEventIds: [] },
    flags: {},
    hidden: {
      queuedEventIds: ["secret-event"],
      secretFlags: { conspiracy: 1 },
      internalNotes: ["sealed note"],
      undiscoveredInformation: {},
      policyTruth: {},
    },
    meta: {
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      sourceIds: ["ming-shi"],
      sourceCatalogPresent: true,
    },
  };
}

describe("Phase 2 Domain Schema", () => {
  it("accepts a strict, versioned GameState", () => {
    expect(GameStateSchema.parse(validState())).toEqual(validState());
  });

  it.each([
    ["negative treasury", ["country", "treasuryTaels"], -1],
    ["percentage over 100", ["country", "stability"], 101],
    ["invalid date", ["currentDate"], "1627-99-99"],
    ["invalid character status", ["characters", "wei-zhongxian", "status"], "missing"],
  ])("rejects %s", (_name, path, value) => {
    const state = structuredClone(validState()) as Record<string, unknown>;
    let target: Record<string, unknown> = state;
    for (const segment of path.slice(0, -1)) {
      target = target[String(segment)] as Record<string, unknown>;
    }
    target[String(path.at(-1))] = value;
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });

  it("rejects invalid policy state and unknown GameState fields", () => {
    const state = validState() as GameState & Record<string, unknown>;
    state.policies.bad = {
      policyId: "bad",
      status: "unknown",
      responsibleOfficeIds: [],
      sourceIds: ["ming-shi"],
    } as never;
    state.extra = true;
    expect(GameStateSchema.safeParse(state).success).toBe(false);
  });

  it("builds a defensive player view without hidden or sealed data", () => {
    const state = validState();
    const view = toPlayerStateView(state);
    expect(view).not.toHaveProperty("hidden");
    expect(JSON.stringify(view)).not.toContain("sealed note");
    view.country.treasuryTaels = 0;
    expect(state.country.treasuryTaels).toBe(4_200_000);
  });

  it.each([
    "game.create",
    "country.adjust-resource",
    "character.assign-office",
    "time.advance",
    "checkpoint.create",
    "save.rollback",
  ])("accepts whitelisted command %s", (commandType) => {
    const payloads: Record<string, unknown> = {
      "game.create": { scenarioId: "chongzhen-early", title: "Demo", seed: "seed" },
      "country.adjust-resource": {
        resource: "treasuryTaels",
        delta: -300_000,
        reason: "test",
      },
      "character.assign-office": { characterId: "wei-zhongxian", officeId: null },
      "time.advance": { days: 1 },
      "checkpoint.create": { kind: "manual", label: "before command" },
      "save.rollback": { targetRevision: 0, mode: "logical", dryRun: true },
    };
    const result = GameCommandSchema.safeParse({
      commandId: `cmd_${commandType}`,
      commandType,
      saveId: "save_demo",
      baseRevision: 0,
      actor: { type: "player", id: "player" },
      payload: payloads[commandType],
      idempotencyKey: "idem_1",
      createdAt: "2026-07-26T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects arbitrary commands and JSON patch payloads", () => {
    expect(
      GameCommandSchema.safeParse({
        commandId: "cmd_bad",
        commandType: "state.patch",
        saveId: "save_demo",
        baseRevision: 0,
        actor: { type: "player", id: "player" },
        payload: [{ op: "replace", path: "/hidden", value: {} }],
        createdAt: "2026-07-26T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates explicit mutations and append-only log entries", () => {
    const mutation = ProposedMutationSchema.parse({
      aggregateType: "country",
      operation: "increment",
      path: "/country/treasuryTaels",
      before: 4_200_000,
      after: 3_900_000,
      reason: "test",
      sourceIds: ["ming-shi"],
      visibility: "public",
      tags: ["resource"],
    });

    expect(
      StateChangeLogEntrySchema.parse({
        logId: "log_1",
        saveId: "save_demo",
        revision: 1,
        txId: "tx_1",
        sequence: 0,
        timestamp: "2026-07-26T00:00:00.000Z",
        actorType: "player",
        actorId: "player",
        commandType: "country.adjust-resource",
        commandId: "cmd_1",
        ...mutation,
        inverse: {
          operation: "set",
          path: "/country/treasuryTaels",
          value: 4_200_000,
        },
        beforeHash: "a".repeat(64),
        afterHash: "b".repeat(64),
        prevLogHash: null,
        entryHash: "c".repeat(64),
      }).entryHash,
    ).toHaveLength(64);
  });

  it("validates the portable save manifest contract", () => {
    expect(
      SaveExportManifestSchema.parse({
        exportFormatVersion: 1,
        appVersion: "0.2.0",
        saveId: "save_demo",
        lineageId: "lineage_demo",
        scenarioId: "chongzhen-early",
        dynastyId: "ming",
        schemaVersion: 1,
        stateVersion: 1,
        baseRevision: 0,
        headRevision: 3,
        exportedAt: "2026-07-26T00:00:00.000Z",
        includeSourceMetadata: true,
        sourceMetadataMode: "full",
        encrypted: false,
        safeShareMode: "none",
      }).headRevision,
    ).toBe(3);
  });
});
