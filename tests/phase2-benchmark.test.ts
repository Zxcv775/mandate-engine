import { describe, expect, it } from "vitest";
import { runPhase2Benchmark } from "../scripts/benchmark-phase2";

describe("Phase 2 benchmark harness", () => {
  it("measures the complete operation set with a disposable reduced fixture", async () => {
    const result = await runPhase2Benchmark({ maxRevision: 20, logTarget: 100, repeats: 1 });

    expect(result.fixture).toMatchObject({ maxRevision: 20, logTarget: 100, repeats: 1 });
    expect(result.transactionMutationCounts).toMatchObject({
      singleDomainMutation: expect.any(Number),
      tenMutationTransaction: 10,
    });
    expect(Object.keys(result.timingsMs)).toEqual(
      expect.arrayContaining([
        "createSave",
        "loadRevision0",
        "loadRevision100",
        "loadRevision1000",
        "commitSingleMutation",
        "commitTenMutations",
        "createCheckpoint",
        "replay50",
        "replay100",
        "exportSave",
        "importSave",
        "validateSave",
      ]),
    );
    expect(result.sizes.tenThousandLogDatabaseBytes).toBeGreaterThan(0);
    expect(result.sizes.averageLogPayloadBytes).toBeGreaterThan(0);
    expect(result.assumptions.length).toBeGreaterThan(0);
  }, 30_000);
});
