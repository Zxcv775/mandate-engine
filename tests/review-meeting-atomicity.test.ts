import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand, MeetingOutcomeCandidate } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";
import { makeAgendaItem, makeSession } from "./helpers/meeting-fixtures";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

function meetingCommand(saveId: string): GameCommand {
  return {
    commandId: "cmd_create_atomic_meeting",
    commandType: "meeting.create",
    saveId,
    baseRevision: 0,
    actor: { type: "system", id: "meeting-director" },
    payload: {
      meetingId: "meeting-atomic",
      meetingType: "imperial-council",
      participantIds: ["wei-zhongxian", "huang-liji"],
      chairCharacterId: "emperor",
      visibility: "meeting",
    },
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

function outcome(
  id: string,
  delta: number,
  overrides: Partial<MeetingOutcomeCandidate> = {},
): MeetingOutcomeCandidate {
  return {
    outcomeCandidateId: id,
    meetingId: "meeting-atomic",
    saveId: "save_atomic",
    agendaItemId: "agenda-atomic",
    type: "resource-allocation-request",
    title: id,
    summary: "拨款",
    proposerIds: ["huang-liji"],
    supporterIds: [],
    opponentIds: [],
    rationale: ["急需"],
    risks: [],
    sourceTurnIds: ["turn-source"],
    status: "presented",
    commandPreview: {
      commandType: "country.adjust-resource",
      payload: { resource: "treasuryTaels", delta, reason: id },
    },
    unsupportedCommand: false,
    createdAtRevision: 1,
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

async function setup(): Promise<{ app: FastifyInstance; system: SaveSystem }> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-review-meeting-atomic-"));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  await system.service.createSave({
    saveId: "save_atomic",
    scenarioId: "chongzhen-early",
    title: "Atomic meeting",
    seed: "atomic-meeting",
  });
  await system.service.commitCommand(meetingCommand("save_atomic"));
  system.meetings.createSession(
    makeSession("scheduled", {
      meetingId: "meeting-atomic",
      saveId: "save_atomic",
      createdAtRevision: 1,
      agendaItemIds: ["agenda-atomic"],
      currentAgendaItemId: "agenda-atomic",
    }),
    [],
    [
      makeAgendaItem({
        agendaItemId: "agenda-atomic",
        meetingId: "meeting-atomic",
        status: "queued",
      }),
    ],
  );
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
  return { app, system };
}

describe("REVIEW-002 meeting world/auxiliary atomicity", () => {
  it("prevalidates every selected outcome before committing any command", async () => {
    const { app, system } = await setup();
    const before = await system.service.loadState("save_atomic");
    const firstCost = -Math.floor(before.country.treasuryTaels * 0.6);
    const secondCost = -Math.floor(before.country.treasuryTaels * 0.7);
    system.meetings.insertOutcomeCandidate(outcome("candidate-first", firstCost));
    system.meetings.insertOutcomeCandidate(outcome("candidate-second", secondCost));

    await expect(
      app.meetingService.issueRuling("save_atomic", "meeting-atomic", {
        expectedRevision: before.revision,
        expectedMeetingVersion: 1,
        agendaItemId: "agenda-atomic",
        selectedOutcomeCandidateIds: ["candidate-first", "candidate-second"],
        text: "两案并准",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const after = await system.service.loadState("save_atomic");
    expect(after.revision).toBe(before.revision);
    expect(after.country.treasuryTaels).toBe(before.country.treasuryTaels);
    expect(
      system.meetings.listOutcomeCandidates("meeting-atomic").map((item) => item.status),
    ).toEqual(["presented", "presented"]);
    expect(system.meetings.listAgendaItems("meeting-atomic")[0]?.status).toBe("queued");
    expect(system.meetings.listTurns("meeting-atomic").turns).toEqual([]);
  });

  it("replays the same ruling idempotency key and rejects a different request hash", async () => {
    const { app, system } = await setup();
    const candidate = outcome("candidate-idempotent", -100);
    system.meetings.insertOutcomeCandidate(candidate);
    const input = {
      expectedRevision: 1,
      expectedMeetingVersion: 1,
      agendaItemId: "agenda-atomic",
      selectedOutcomeCandidateIds: [candidate.outcomeCandidateId],
      idempotencyKey: "ruling-key-1",
      text: "准拨一百两",
    };

    const first = await app.meetingService.issueRuling("save_atomic", "meeting-atomic", input);
    const replayed = await app.meetingService.issueRuling("save_atomic", "meeting-atomic", input);

    expect(replayed).toEqual(first);
    expect((await system.service.loadState("save_atomic")).revision).toBe(2);
    expect(system.meetings.listTurns("meeting-atomic").turns).toHaveLength(1);
    await expect(
      app.meetingService.issueRuling("save_atomic", "meeting-atomic", {
        ...input,
        selectedOutcomeCandidateIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("rolls back meeting.cancel when the auxiliary session update fails", async () => {
    const { app, system } = await setup();
    const before = await system.service.loadState("save_atomic");
    const originalUpdate = system.meetings.updateSession.bind(system.meetings);
    system.meetings.updateSession = () => {
      throw new Error("injected:update-session");
    };

    await expect(
      app.meetingService.cancelMeeting("save_atomic", "meeting-atomic", {
        expectedRevision: before.revision,
        reason: "fault injection",
      }),
    ).rejects.toThrow("injected:update-session");
    system.meetings.updateSession = originalUpdate;

    const after = await system.service.loadState("save_atomic");
    expect(after.revision).toBe(before.revision);
    expect(after.meetings["meeting-atomic"]?.status).toBe("scheduled");
    expect(system.meetings.getSession("meeting-atomic")?.status).toBe("scheduled");
  });

  it("rolls back meeting.start when opening Transcript persistence fails", async () => {
    const { app, system } = await setup();
    const originalAppend = system.meetings.appendTurn.bind(system.meetings);
    system.meetings.appendTurn = () => {
      throw new Error("injected:opening-turn");
    };
    await expect(
      app.meetingService.startMeeting("save_atomic", "meeting-atomic", {
        expectedRevision: 1,
        expectedMeetingVersion: 1,
      }),
    ).rejects.toThrow("injected:opening-turn");
    system.meetings.appendTurn = originalAppend;
    const state = await system.service.loadState("save_atomic");
    expect(state.revision).toBe(1);
    expect(state.meetings["meeting-atomic"]?.status).toBe("scheduled");
    expect(system.meetings.getSession("meeting-atomic")?.status).toBe("scheduled");
    expect(system.meetings.listTurns("meeting-atomic").turns).toEqual([]);
  });

  it("rolls back meeting.conclude, leak, Transcript and session when minutes fail", async () => {
    const { app, system } = await setup();
    await app.meetingService.startMeeting("save_atomic", "meeting-atomic", {
      expectedRevision: 1,
      expectedMeetingVersion: 1,
    });
    const session = system.meetings.getSession("meeting-atomic")!;
    const before = await system.service.loadState("save_atomic");
    const turnsBefore = system.meetings.listTurns("meeting-atomic").turns;
    const originalInsertMinutes = system.meetings.insertMinutes.bind(system.meetings);
    system.meetings.insertMinutes = () => {
      throw new Error("injected:minutes");
    };
    await expect(
      app.meetingService.concludeMeeting("save_atomic", "meeting-atomic", {
        expectedRevision: before.revision,
        expectedMeetingVersion: session.meetingVersion,
      }),
    ).rejects.toThrow("injected:minutes");
    system.meetings.insertMinutes = originalInsertMinutes;
    const after = await system.service.loadState("save_atomic");
    expect(after.revision).toBe(before.revision);
    expect(after.meetings["meeting-atomic"]?.status).toBe("in-progress");
    expect(system.meetings.getSession("meeting-atomic")?.status).toBe("in-progress");
    expect(system.meetings.listTurns("meeting-atomic").turns).toEqual(turnsBefore);
    expect(system.meetings.listMinutes("meeting-atomic", { includePrivate: true })).toEqual([]);
    expect(system.meetings.getLeakAssessment("meeting-atomic")).toBeNull();
  });
});
