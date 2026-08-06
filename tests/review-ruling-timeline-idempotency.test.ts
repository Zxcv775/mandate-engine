import { createScenarioLoader } from "@mandate/data-loader";
import {
  DEFAULT_MEETING_LIMITS,
  type GameCommand,
  type MeetingAgendaItem,
  type MeetingOutcomeCandidate,
  type MeetingSessionState,
} from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function createRulingFixture(databasePath = ":memory:", registerCleanup = true) {
  const saveId = "save_ruling_timeline";
  const meetingId = "meeting_ruling_timeline";
  const agendaItemId = "agenda_ruling_timeline";
  const outcomeCandidateId = "outcome_ruling_timeline";
  const system = createSaveSystem({
    databasePath,
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  const app = await buildApp({
    config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
    saveSystem: system,
    logger: false,
  });
  if (registerCleanup) {
    cleanup.push(() => system.close());
    cleanup.push(() => app.close());
  }

  await system.service.createSave({
    saveId,
    scenarioId: "chongzhen-early",
    title: "ruling timeline",
    seed: "ruling-timeline",
  });
  const createCommand: GameCommand = {
    commandId: "cmd_create_ruling_timeline",
    commandType: "meeting.create",
    saveId,
    baseRevision: 0,
    actor: { type: "system", id: "meeting-director" },
    payload: {
      meetingId,
      meetingType: "imperial-council",
      participantIds: ["huang-liji"],
      chairCharacterId: "emperor",
      visibility: "meeting",
    },
    createdAt: FIXTURE_NOW,
  };
  await system.service.commitCommand(createCommand);
  const session: MeetingSessionState = {
    meetingId,
    saveId,
    type: "imperial-council",
    status: "waiting-for-player",
    title: "裁决时间线",
    purpose: "验证回滚后的裁决幂等键",
    createdAtRevision: 1,
    meetingVersion: 1,
    turnNumber: 0,
    participantIds: ["huang-liji"],
    chairCharacterId: "emperor",
    agendaItemIds: [agendaItemId],
    currentAgendaItemId: agendaItemId,
    limits: DEFAULT_MEETING_LIMITS,
    usedTurns: 0,
    visibility: "meeting",
    outcomeCandidateIds: [outcomeCandidateId],
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
  const agenda: MeetingAgendaItem = {
    agendaItemId,
    meetingId,
    title: "赈济立案",
    description: "验证裁决重放",
    topicIds: ["review"],
    proposerId: "emperor",
    status: "discussing",
    priority: 50,
    sequence: 0,
    maxTurns: 10,
    usedTurns: 0,
    relatedEntityIds: [],
    requiredOfficeIds: [],
    visibility: "meeting",
  };
  system.meetings.createSession(session, [], [agenda]);
  const outcome: MeetingOutcomeCandidate = {
    outcomeCandidateId,
    meetingId,
    saveId,
    agendaItemId,
    type: "policy-proposal",
    title: "赈济陕西",
    summary: "建立政策",
    proposerIds: ["huang-liji"],
    supporterIds: [],
    opponentIds: [],
    rationale: ["独立复现"],
    risks: [],
    sourceTurnIds: ["source_turn_ruling_timeline"],
    status: "presented",
    commandPreview: {
      commandType: "policy.propose",
      payload: { templateId: "policy-zhenji-shaanxi" },
    },
    unsupportedCommand: false,
    createdAtRevision: 1,
    createdAt: FIXTURE_NOW,
  };
  system.meetings.insertOutcomeCandidate(outcome);

  return {
    system,
    app,
    saveId,
    meetingId,
    input: {
      expectedRevision: 1,
      expectedMeetingVersion: 1,
      agendaItemId,
      selectedOutcomeCandidateIds: [outcomeCandidateId],
      idempotencyKey: "same-key-across-timeline",
      text: "准议",
    },
  };
}

describe("review-ruling-timeline-idempotency", () => {
  it("allows the same ruling key on a new rollback timeline and replays only the current result", async () => {
    const { system, app, saveId, meetingId, input } = await createRulingFixture();

    const first = await app.meetingService.issueRuling(saveId, meetingId, input);
    expect(first).toMatchObject({ acceptedCommands: 1, newTurn: { stateRevision: 2 } });
    expect((await system.service.loadState(saveId)).revision).toBe(2);
    const rollback = await system.service.rollback(saveId, { targetRevision: 1 });
    expect(rollback.resultRevision).toBe(3);
    expect(
      system.meetings.getRulingByIdempotencyKey(saveId, meetingId, input.idempotencyKey),
    ).toBeNull();

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/meetings/${meetingId}/rulings`,
      payload: { ...input, expectedRevision: 3 },
    });
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({
      ok: true,
      data: { acceptedCommands: 1, newTurn: { stateRevision: 4 } },
    });
    expect(
      system.meetings.getRulingByIdempotencyKey(saveId, meetingId, input.idempotencyKey),
    ).toMatchObject({ stateRevision: 4 });
    expect(
      (
        system.database
          .prepare(
            "SELECT COUNT(*) AS count FROM meeting_rulings WHERE save_id = ? AND meeting_id = ? AND idempotency_key = ?",
          )
          .get(saveId, meetingId, input.idempotencyKey) as { count: number }
      ).count,
    ).toBe(2);

    const replayResponse = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/meetings/${meetingId}/rulings`,
      payload: { ...input, expectedRevision: 3 },
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().data).toEqual(retryResponse.json().data);
    expect((await system.service.loadState(saveId)).revision).toBe(4);

    const differentKey = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/meetings/${meetingId}/rulings`,
      payload: { ...input, idempotencyKey: "different-key", expectedRevision: 4 },
    });
    expect(differentKey.statusCode).toBe(409);
    expect(differentKey.json()).toMatchObject({ error: { code: "MEETING_VERSION_STALE" } });

    const secondRollback = await system.service.rollback(saveId, { targetRevision: 1 });
    expect(secondRollback.resultRevision).toBe(5);
    const secondTimeline = await app.meetingService.issueRuling(saveId, meetingId, {
      ...input,
      expectedRevision: 5,
    });
    expect(secondTimeline).toMatchObject({ newTurn: { stateRevision: 6 } });
    expect((await system.service.loadState(saveId)).revision).toBe(6);
    expect(
      (
        system.database
          .prepare(
            "SELECT COUNT(*) AS count FROM meeting_rulings WHERE save_id = ? AND meeting_id = ? AND idempotency_key = ?",
          )
          .get(saveId, meetingId, input.idempotencyKey) as { count: number }
      ).count,
    ).toBe(3);

    const exported = await system.service.exportSave(saveId, {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const importedSystem = createSaveSystem({
      databasePath: ":memory:",
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    const importedApp = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      saveSystem: importedSystem,
      logger: false,
    });
    cleanup.push(() => importedSystem.close());
    cleanup.push(() => importedApp.close());
    await importedSystem.service.importSave({ bytes: exported.bytes });
    expect(
      importedSystem.meetings.getRulingByIdempotencyKey(saveId, meetingId, input.idempotencyKey),
    ).toMatchObject({ stateRevision: 6 });
    const importedReplay = await importedApp.meetingService.issueRuling(saveId, meetingId, {
      ...input,
      expectedRevision: 5,
    });
    expect(importedReplay).toEqual(secondTimeline);
    expect((await importedSystem.service.loadState(saveId)).revision).toBe(6);

    const forkSystem = createSaveSystem({
      databasePath: ":memory:",
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    cleanup.push(() => forkSystem.close());
    await forkSystem.service.createSave({
      saveId,
      scenarioId: "chongzhen-early",
      title: "divergent local ruling line",
      seed: "divergent-local-ruling-line",
    });
    const forked = await forkSystem.service.importSave({ bytes: exported.bytes });
    expect(forked.result).toBe("forked");
    expect(forked.saveId).not.toBe(saveId);
    expect((await forkSystem.service.loadState(forked.saveId)).revision).toBe(6);
    expect(
      (
        forkSystem.database
          .prepare("SELECT COUNT(*) AS count FROM meeting_rulings WHERE save_id = ?")
          .get(forked.saveId) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("converges concurrent same-key rulings to one current transaction", async () => {
    const { system, app, saveId, meetingId, input } = await createRulingFixture();

    const [left, right] = await Promise.all([
      app.meetingService.issueRuling(saveId, meetingId, input),
      app.meetingService.issueRuling(saveId, meetingId, input),
    ]);

    expect(right).toEqual(left);
    expect((await system.service.loadState(saveId)).revision).toBe(2);
    expect(
      (
        system.database
          .prepare(
            "SELECT COUNT(*) AS count FROM meeting_rulings WHERE save_id = ? AND meeting_id = ? AND idempotency_key = ?",
          )
          .get(saveId, meetingId, input.idempotencyKey) as { count: number }
      ).count,
    ).toBe(1);
  });

  it("restores current-timeline ruling idempotency after reopening SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-ruling-restart-"));
    const databasePath = join(directory, "save.sqlite");
    let reopenedSystem: ReturnType<typeof createSaveSystem> | undefined;
    let reopenedApp: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const { system, app, saveId, meetingId, input } = await createRulingFixture(
        databasePath,
        false,
      );
      await app.meetingService.issueRuling(saveId, meetingId, input);
      await system.service.rollback(saveId, { targetRevision: 1 });
      const currentResult = await app.meetingService.issueRuling(saveId, meetingId, {
        ...input,
        expectedRevision: 3,
      });
      await app.close();
      system.close();

      reopenedSystem = createSaveSystem({
        databasePath,
        scenarioLoader: createScenarioLoader(),
        clock: new FixedClock(FIXTURE_NOW),
      });
      reopenedApp = await buildApp({
        config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
        saveSystem: reopenedSystem,
        logger: false,
      });
      expect(
        reopenedSystem.meetings.getRulingByIdempotencyKey(saveId, meetingId, input.idempotencyKey),
      ).toMatchObject({ stateRevision: 4 });
      expect(
        await reopenedApp.meetingService.issueRuling(saveId, meetingId, {
          ...input,
          expectedRevision: 3,
        }),
      ).toEqual(currentResult);
      expect((await reopenedSystem.service.loadState(saveId)).revision).toBe(4);
    } finally {
      await reopenedApp?.close();
      reopenedSystem?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
