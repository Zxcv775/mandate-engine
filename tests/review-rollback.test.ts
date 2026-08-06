import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";
import { makeSession } from "./helpers/meeting-fixtures";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(saveId: string): Promise<SaveSystem> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-review-rollback-"));
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
    saveId,
    scenarioId: "chongzhen-early",
    title: "Review rollback",
    seed: "review-rollback",
  });
  return system;
}

function command(
  saveId: string,
  commandType: GameCommand["commandType"],
  baseRevision: number,
  payload: Record<string, unknown>,
): GameCommand {
  return {
    commandId: `cmd_${commandType}_${baseRevision}`,
    commandType,
    saveId,
    baseRevision,
    actor: { type: "player", id: "player" },
    payload,
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

async function issuePolicy(system: SaveSystem, saveId: string): Promise<number> {
  await system.service.commitCommand(
    command(saveId, "policy.propose", 0, {
      policyId: "p1",
      templateId: "policy-zhenji-shaanxi",
      origin: { kind: "direct-decree" },
    }),
  );
  await system.service.commitCommand(command(saveId, "policy.approve", 1, { policyId: "p1" }));
  await system.service.commitCommand(
    command(saveId, "policy.issue", 2, {
      policyId: "p1",
      responsibleInstitutionId: "hu-bu",
      responsibleCharacterIds: ["huang-liji"],
      additionalBudget: { treasuryTaels: 20_000, grainReserveShi: 10_000 },
    }),
  );
  return 3;
}

describe("REVIEW-001 rollback timeline projection", () => {
  it("hides a rolled-back meeting from the current projection without deleting its audit row", async () => {
    const system = await setup("save_meeting_timeline");
    await system.service.commitCommand(
      command("save_meeting_timeline", "meeting.create", 0, {
        meetingId: "meeting-rolled-back",
        meetingType: "imperial-council",
        participantIds: ["wei-zhongxian", "huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    system.meetings.createSession(
      makeSession("scheduled", {
        meetingId: "meeting-rolled-back",
        saveId: "save_meeting_timeline",
        createdAtRevision: 1,
      }),
      [],
      [],
    );

    await system.service.rollback("save_meeting_timeline", { targetRevision: 0 });

    expect((await system.service.loadState("save_meeting_timeline")).meetings).toEqual({});
    expect(system.meetings.listSessions("save_meeting_timeline")).toEqual([]);
    expect(system.meetings.getSession("meeting-rolled-back")).toBeNull();
    expect(
      Number(
        (
          system.database
            .prepare("SELECT COUNT(*) AS count FROM meeting_sessions WHERE meeting_id = ?")
            .get("meeting-rolled-back") as { count: number }
        ).count,
      ),
    ).toBe(1);

    const exported = await system.service.exportSave("save_meeting_timeline", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const target = await setup("unrelated_target_save");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    expect(imported.saveId).toBe("save_meeting_timeline");
    expect(target.meetings.listSessions("save_meeting_timeline")).toEqual([]);
    expect(
      Number(
        (
          target.database
            .prepare("SELECT COUNT(*) AS count FROM meeting_sessions WHERE meeting_id = ?")
            .get("meeting-rolled-back") as { count: number }
        ).count,
      ),
    ).toBe(1);
  });

  it("hides rolled-back policy artifacts and appends a fresh audit row when the tick is replayed", async () => {
    const system = await setup("save_policy_timeline");
    const issuedRevision = await issuePolicy(system, "save_policy_timeline");
    await system.service.advanceTime("save_policy_timeline", {
      commandId: "cmd_advance_first",
      baseRevision: issuedRevision,
      days: 1,
    });
    expect(system.policyDetails.listReports("save_policy_timeline", "p1").reports).toHaveLength(1);

    const rollback = await system.service.rollback("save_policy_timeline", {
      targetRevision: issuedRevision,
    });
    expect(system.policyDetails.listReports("save_policy_timeline", "p1").reports).toEqual([]);

    await system.service.advanceTime("save_policy_timeline", {
      commandId: "cmd_advance_replay",
      baseRevision: rollback.resultRevision!,
      days: 1,
    });

    const currentReports = system.policyDetails.listReports("save_policy_timeline", "p1").reports;
    expect(currentReports).toHaveLength(1);
    expect(currentReports[0]?.revision).toBe(rollback.resultRevision! + 1);
    expect(
      Number(
        (
          system.database
            .prepare(
              "SELECT COUNT(*) AS count FROM policy_reports WHERE save_id = ? AND policy_id = ?",
            )
            .get("save_policy_timeline", "p1") as { count: number }
        ).count,
      ),
    ).toBe(4);
  });
});
