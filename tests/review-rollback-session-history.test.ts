import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand, MeetingOutcomeCandidate } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";
import { makeAgendaItem, makeParticipant, makeSession } from "./helpers/meeting-fixtures";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(): Promise<{
  system: SaveSystem;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-session-history-"));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  const app = await buildApp({
    config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
    saveSystem: system,
    logger: false,
  });
  cleanup.push(async () => {
    await app.close();
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  await system.service.createSave({
    saveId: "save_session_history",
    scenarioId: "chongzhen-early",
    title: "session history",
    seed: "session-history",
  });
  return { system, app };
}

function createMeetingCommand(meetingId: string, baseRevision: number): GameCommand {
  return {
    commandId: `cmd_create_${meetingId}_${baseRevision}`,
    commandType: "meeting.create",
    saveId: "save_session_history",
    baseRevision,
    actor: { type: "system", id: "meeting-director" },
    payload: {
      meetingId,
      meetingType: "imperial-council",
      participantIds: ["wei-zhongxian", "huang-liji"],
      chairCharacterId: "emperor",
      visibility: "meeting",
    },
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

async function createMeeting(system: SaveSystem, meetingId: string, baseRevision: number) {
  const committed = await system.service.commitCommand(
    createMeetingCommand(meetingId, baseRevision),
  );
  system.meetings.createSession(
    makeSession("scheduled", {
      meetingId,
      saveId: "save_session_history",
      createdAtRevision: committed.revision,
      agendaItemIds: [`agenda-${meetingId}`],
      currentAgendaItemId: `agenda-${meetingId}`,
    }),
    [],
    [
      makeAgendaItem({
        agendaItemId: `agenda-${meetingId}`,
        meetingId,
        status: "queued",
      }),
    ],
  );
  return committed.revision;
}

describe("review-rollback-session-history", () => {
  it("projects the last session version on the current branch and permits replay", async () => {
    const { system, app } = await setup();
    const createdRevision = await createMeeting(system, "meeting-history", 0);
    await app.meetingService.startMeeting("save_session_history", "meeting-history", {
      expectedRevision: createdRevision,
      expectedMeetingVersion: 1,
    });
    expect(system.meetings.getSession("meeting-history")).toMatchObject({
      status: "in-progress",
      meetingVersion: 4,
    });
    expect(system.meetings.listTurns("meeting-history").turns).toHaveLength(1);

    const firstRollback = await system.service.rollback("save_session_history", {
      targetRevision: createdRevision,
    });
    expect(
      (await system.service.loadState("save_session_history")).meetings["meeting-history"],
    ).toMatchObject({ status: "scheduled" });
    expect(system.meetings.getSession("meeting-history")).toMatchObject({
      status: "scheduled",
      meetingVersion: 1,
    });
    expect(system.meetings.listTurns("meeting-history").turns).toEqual([]);

    await app.meetingService.startMeeting("save_session_history", "meeting-history", {
      expectedRevision: firstRollback.resultRevision!,
      expectedMeetingVersion: 1,
    });
    const replayed = system.meetings.getSession("meeting-history");
    expect(replayed).toMatchObject({ status: "in-progress", meetingVersion: 4 });
    expect(system.meetings.listTurns("meeting-history").turns).toHaveLength(1);

    const secondRollback = await system.service.rollback("save_session_history", {
      targetRevision: firstRollback.resultRevision!,
    });
    expect(system.meetings.getSession("meeting-history")).toMatchObject({
      status: "scheduled",
      meetingVersion: 1,
    });

    const rootRollback = await system.service.rollback("save_session_history", {
      targetRevision: 0,
    });
    expect(system.meetings.getSession("meeting-history")).toBeNull();
    expect(system.meetings.listSessions("save_session_history")).toEqual([]);

    await createMeeting(system, "meeting-new-branch", rootRollback.resultRevision!);
    expect(
      system.meetings.listSessions("save_session_history").map((item) => item.meetingId),
    ).toEqual(["meeting-new-branch"]);
    expect(system.meetings.getSession("meeting-history")).toBeNull();
    expect(secondRollback.resultRevision).toBeLessThan(rootRollback.resultRevision!);

    expect(
      Number(
        (
          system.database.prepare("SELECT COUNT(*) AS count FROM meeting_sessions").get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(2);
  });

  it.each(["paused", "waiting-for-agent", "waiting-for-player", "concluded", "cancelled"] as const)(
    "restores the session before a %s branch state",
    async (status) => {
      const { system } = await setup();
      const createdRevision = await createMeeting(system, `meeting-${status}`, 0);
      await system.service.advanceTime("save_session_history", {
        commandId: `cmd_advance_${status}`,
        baseRevision: createdRevision,
        days: 1,
      });
      const scheduled = system.meetings.requireSession(`meeting-${status}`);
      system.meetings.updateSession(
        {
          ...scheduled,
          status,
          meetingVersion: scheduled.meetingVersion + 1,
          ...(status === "paused" ? { pauseReason: "测试暂停" } : {}),
          ...(status === "concluded" ? { concludedAtRevision: createdRevision + 1 } : {}),
        },
        scheduled.meetingVersion,
      );
      expect(system.meetings.getSession(`meeting-${status}`)?.status).toBe(status);

      await system.service.rollback("save_session_history", { targetRevision: createdRevision });
      expect(system.meetings.getSession(`meeting-${status}`)).toMatchObject({
        status: "scheduled",
        meetingVersion: 1,
      });
      expect(
        Number(
          (
            system.database
              .prepare(
                "SELECT COUNT(*) AS count FROM meeting_session_versions WHERE meeting_id = ?",
              )
              .get(`meeting-${status}`) as { count: number }
          ).count,
        ),
      ).toBe(2);
    },
  );

  it("restores mutable participant, agenda and outcome projections with the session", async () => {
    const { system } = await setup();
    const meetingId = "meeting-aux-history";
    const createdRevision = await createMeeting(system, meetingId, 0);
    system.meetings.upsertParticipant(makeParticipant("huang-liji", { meetingId, turnsSpoken: 0 }));
    const candidate: MeetingOutcomeCandidate = {
      outcomeCandidateId: "outcome-aux-history",
      meetingId,
      saveId: "save_session_history",
      agendaItemId: `agenda-${meetingId}`,
      type: "policy-proposal",
      title: "候选",
      summary: "候选",
      proposerIds: ["huang-liji"],
      supporterIds: [],
      opponentIds: [],
      rationale: ["测试"],
      risks: [],
      sourceTurnIds: ["source-turn"],
      status: "presented",
      unsupportedCommand: false,
      createdAtRevision: createdRevision,
      createdAt: FIXTURE_NOW,
    };
    system.meetings.insertOutcomeCandidate(candidate);

    await system.service.advanceTime("save_session_history", {
      commandId: "cmd_advance_aux_history",
      baseRevision: createdRevision,
      days: 1,
    });
    system.meetings.upsertParticipant(makeParticipant("huang-liji", { meetingId, turnsSpoken: 5 }));
    system.meetings.upsertAgendaItem(
      makeAgendaItem({
        agendaItemId: `agenda-${meetingId}`,
        meetingId,
        status: "resolved",
        usedTurns: 5,
      }),
    );
    system.meetings.updateOutcomeStatus(candidate.outcomeCandidateId, "accepted");
    expect(system.meetings.listParticipants(meetingId)[0]?.turnsSpoken).toBe(5);
    expect(system.meetings.listAgendaItems(meetingId)[0]).toMatchObject({
      status: "resolved",
      usedTurns: 5,
    });
    expect(system.meetings.listOutcomeCandidates(meetingId)[0]?.status).toBe("accepted");

    await system.service.rollback("save_session_history", { targetRevision: createdRevision });
    expect(system.meetings.listParticipants(meetingId)[0]?.turnsSpoken).toBe(0);
    expect(system.meetings.listAgendaItems(meetingId)[0]).toMatchObject({
      status: "queued",
      usedTurns: 0,
    });
    expect(system.meetings.listOutcomeCandidates(meetingId)[0]?.status).toBe("presented");
  });
});
