import type { GameCommand, GameState, ProposedMutation } from "@mandate/domain";
import {
  FixedClock,
  StateEngine,
  StateEngineError,
  applyMutation,
  applyMutations,
  createDeterministicRandomSource,
  createInitialGameState,
  hashState,
  invertMutation,
  sha256Hex,
  stableStringify,
  type ScenarioInitializationBundle,
} from "@mandate/game-engine";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW, makeFixtureBundle, makeFixtureState } from "./helpers/character-fixtures";

const NOW = FIXTURE_NOW;

function bundle(): ScenarioInitializationBundle {
  return makeFixtureBundle();
}

function state(): GameState {
  return makeFixtureState();
}

function command(
  commandType: "country.adjust-resource" | "character.assign-office" | "time.advance",
  payload: unknown,
  baseRevision = 0,
): GameCommand {
  return {
    commandId: `cmd_${commandType}`,
    commandType,
    saveId: "save_demo",
    baseRevision,
    actor: { type: "player", id: "player" },
    payload,
    createdAt: NOW,
  } as GameCommand;
}

describe("stable serialization and hashing", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1],"d":4},"b":2}',
    );
  });

  it("produces the same SHA-256 for structurally equal states", () => {
    const a = state();
    const b = JSON.parse(stableStringify(a)) as GameState;
    expect(hashState(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe("deterministic random source", () => {
  it("recreates a sequence from the persisted seed and cursor", () => {
    const first = createDeterministicRandomSource("seed");
    const prefix = [first.nextFloat(), first.nextInt(1, 6), first.pick(["a", "b", "c"] as const)];
    const cursor = first.getCursor();
    const expectedNext = first.nextFloat();

    const resumed = createDeterministicRandomSource("seed", cursor);
    expect(prefix).toHaveLength(3);
    expect(resumed.getCursor()).toBe(cursor);
    expect(resumed.nextFloat()).toBe(expectedNext);
  });

  it("rejects invalid ranges and empty picks without moving the cursor", () => {
    const rng = createDeterministicRandomSource("seed");
    expect(() => rng.nextInt(2, 1)).toThrow();
    expect(() => rng.pick([])).toThrow();
    expect(rng.getCursor()).toBe(0);
  });
});

describe("initial GameState", () => {
  it("instantiates a validated runtime copy without mutating templates", () => {
    const source = bundle();
    const before = structuredClone(source);
    const result = createInitialGameState(
      source,
      { saveId: "save_demo", seed: "fixed-seed" },
      new FixedClock(NOW),
    );

    expect(result).toMatchObject({
      saveId: "save_demo",
      scenarioId: "chongzhen-early",
      dynastyId: "ming",
      revision: 0,
      tick: 0,
      currentDate: "1627-10-02",
      rng: { seed: sha256Hex("fixed-seed"), cursor: 0 },
    });
    expect(result.characters["wei-zhongxian"]?.sourceIds).toEqual(["ming-shi"]);
    expect(result.offices["chief-grand-secretary"]?.holderCharacterId).toBeNull();
    expect(source).toEqual(before);
  });
});

describe("mutation applier", () => {
  const setMutation: ProposedMutation = {
    aggregateType: "country",
    operation: "set",
    path: "/country/stability",
    before: 45,
    after: 50,
    sourceIds: [],
    visibility: "public",
  };

  it("applies set and increment mutations to a clone", () => {
    const original = state();
    const result = applyMutations(original, [
      setMutation,
      {
        aggregateType: "country",
        operation: "increment",
        path: "/country/treasuryTaels",
        before: 4_200_000,
        after: 4_200_100,
        sourceIds: [],
        visibility: "public",
      },
    ]);
    expect(result.country.stability).toBe(50);
    expect(result.country.treasuryTaels).toBe(4_200_100);
    expect(original.country.stability).toBe(45);
  });

  it("creates an inverse mutation that restores the original hash", () => {
    const original = state();
    const changed = applyMutation(original, setMutation);
    const restored = applyMutation(changed, invertMutation(setMutation));
    expect(hashState(restored)).toBe(hashState(original));
  });

  it("rejects missing, polluted, and stale paths", () => {
    expect(() => applyMutation(state(), { ...setMutation, path: "/country/missing" })).toThrow(
      StateEngineError,
    );
    expect(() =>
      applyMutation(state(), { ...setMutation, path: "/__proto__/polluted" }),
    ).toThrow(StateEngineError);
    expect(() => applyMutation(state(), { ...setMutation, before: 99 })).toThrow(
      /before/i,
    );
  });

  it("leaves the source state unchanged when a later mutation fails", () => {
    const original = state();
    expect(() =>
      applyMutations(original, [
        setMutation,
        { ...setMutation, path: "/country/missing", before: 50, after: 51 },
      ]),
    ).toThrow(StateEngineError);
    expect(original.country.stability).toBe(45);
    expect(hashState(original)).toBe(hashState(state()));
  });
});

describe("StateEngine.applyCommand", () => {
  const engine = new StateEngine({ clock: new FixedClock(NOW) });

  it("commits a resource adjustment as one new revision with inverse mutations", () => {
    const original = state();
    const result = engine.applyCommand(
      original,
      command("country.adjust-resource", {
        resource: "treasuryTaels",
        delta: -300_000,
        reason: "辽饷首拨",
      }),
    );

    expect(result.nextState.country.treasuryTaels).toBe(3_900_000);
    expect(result.nextState.revision).toBe(1);
    expect(result.mutations.some((item) => item.path === "/country/treasuryTaels")).toBe(true);
    expect(result.inverseMutations).toHaveLength(result.mutations.length);
    expect(result.beforeHash).toBe(hashState(original));
    expect(result.afterHash).toBe(hashState(result.nextState));
    expect(original.revision).toBe(0);
  });

  it("rejects a stale base revision before changing state", () => {
    expect(() =>
      engine.applyCommand(
        state(),
        command("country.adjust-resource", {
          resource: "treasuryTaels",
          delta: -1,
          reason: "test",
        }, 1),
      ),
    ).toThrowError(expect.objectContaining({ code: "STATE_REVISION_CONFLICT" }));
  });

  it("rejects a resource adjustment that would violate GameState bounds", () => {
    expect(() =>
      engine.applyCommand(
        state(),
        command("country.adjust-resource", {
          resource: "treasuryTaels",
          delta: -4_200_001,
          reason: "invalid",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "STATE_VALIDATION_FAILED" }));
  });

  it("assigns an existing office and updates both sides atomically", () => {
    const result = engine.applyCommand(
      state(),
      command("character.assign-office", {
        characterId: "wei-zhongxian",
        officeId: "chief-grand-secretary",
      }),
    );
    expect(result.nextState.characters["wei-zhongxian"]?.officeId).toBe(
      "chief-grand-secretary",
    );
    expect(result.nextState.offices["chief-grand-secretary"]?.holderCharacterId).toBe(
      "wei-zhongxian",
    );
  });

  it("advances date and tick without consuming RNG when no random hook runs", () => {
    const result = engine.applyCommand(state(), command("time.advance", { days: 2 }));
    expect(result.nextState.currentDate).toBe("1627-10-04");
    expect(result.nextState.tick).toBe(2);
    expect(result.nextState.rng.cursor).toBe(0);
    expect(result.nextState.revision).toBe(1);
  });

  it("replays the same commands to the same state hash", () => {
    const commands = [
      command("country.adjust-resource", {
        resource: "treasuryTaels",
        delta: -100,
        reason: "test",
      }),
      command("time.advance", { days: 1 }, 1),
    ];
    const run = () => commands.reduce((current, item) => engine.applyCommand(current, item).nextState, state());
    expect(hashState(run())).toBe(hashState(run()));
  });
});
