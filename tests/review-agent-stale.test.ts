import { createScenarioLoader } from "@mandate/data-loader";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import type { LLMProvider } from "@mandate/llm-adapters";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("REVIEW-004 provider-return revision validation", () => {
  it("rejects a stale character response and persists neither conversation nor memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-review-agent-stale-"));
    const system = createSaveSystem({
      databasePath: join(directory, "save.sqlite"),
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    const base = createCharacterMockProvider(
      { defaultStance: "support" },
      { "wei-zhongxian": "魏忠贤" },
    );
    let releaseProvider!: () => void;
    let signalStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: LLMProvider = {
      name: base.name,
      async generate(messages, options) {
        signalStarted();
        await providerGate;
        return base.generate(messages, options);
      },
      generateStructured: (messages, options) => base.generateStructured(messages, options),
    };
    const app = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      provider,
      saveSystem: system,
      logger: false,
    });
    cleanup.push(async () => {
      await app.close();
      system.close();
      await rm(directory, { recursive: true, force: true });
    });
    await app.inject({
      method: "POST",
      url: "/api/saves",
      payload: { saveId: "save_stale", scenarioId: "chongzhen-early", title: "Stale", seed: "s" },
    });

    const responsePromise = app.inject({
      method: "POST",
      url: "/api/saves/save_stale/characters/wei-zhongxian/respond",
      payload: {
        expectedRevision: 0,
        mode: "private-audience",
        input: { speakerId: "emperor", text: "卿意如何？" },
      },
    });
    await providerStarted;
    const concurrent = await app.inject({
      method: "POST",
      url: "/api/saves/save_stale/commands",
      payload: {
        commandId: "cmd_concurrent",
        commandType: "country.adjust-resource",
        baseRevision: 0,
        payload: { resource: "treasuryTaels", delta: -1, reason: "并发推进" },
      },
    });
    expect(concurrent.statusCode).toBe(200);
    releaseProvider();

    const response = await responsePromise;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_CONTEXT_STALE");
    expect(system.characterMemories.listMemories("save_stale", "wei-zhongxian").memories).toEqual(
      [],
    );
    expect(system.characterMemories.listRecentTurns("save_stale", "wei-zhongxian", 10)).toEqual([]);
  });

  it("rejects a stale meeting response and preserves the pending reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-review-meeting-stale-"));
    const system = createSaveSystem({
      databasePath: join(directory, "save.sqlite"),
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    const base = createCharacterMockProvider(
      { defaultStance: "support" },
      { "wei-zhongxian": "魏忠贤", "huang-liji": "黄立极" },
    );
    let releaseProvider!: () => void;
    let signalStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: LLMProvider = {
      name: base.name,
      async generate(messages, options) {
        signalStarted();
        await providerGate;
        return base.generate(messages, options);
      },
      generateStructured: (messages, options) => base.generateStructured(messages, options),
    };
    const app = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      provider,
      saveSystem: system,
      logger: false,
    });
    cleanup.push(async () => {
      await app.close();
      system.close();
      await rm(directory, { recursive: true, force: true });
    });
    await app.inject({
      method: "POST",
      url: "/api/saves",
      payload: {
        saveId: "save_meeting_stale",
        scenarioId: "chongzhen-early",
        title: "Stale",
        seed: "s",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/meetings",
      payload: {
        meetingId: "meeting_stale",
        type: "imperial-council",
        title: "御前会议",
        purpose: "议事",
        participantIds: ["wei-zhongxian", "huang-liji"],
        expectedRevision: 0,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/meetings/meeting_stale/agenda",
      payload: { agendaItemId: "agenda_stale", title: "议题", description: "议题描述" },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/meetings/meeting_stale/start",
      payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
    });
    let session = (
      await app.inject({
        method: "GET",
        url: "/api/saves/save_meeting_stale/meetings/meeting_stale",
      })
    ).json().data.session;
    const advanced = await app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/meetings/meeting_stale/step",
      payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
    });
    session = advanced.json().data.session;
    const responsePromise = app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/meetings/meeting_stale/step",
      payload: {
        expectedRevision: 2,
        expectedMeetingVersion: session.meetingVersion,
        idempotencyKey: "act-stale",
      },
    });
    await providerStarted;
    const concurrent = await app.inject({
      method: "POST",
      url: "/api/saves/save_meeting_stale/commands",
      payload: {
        commandId: "cmd_meeting_concurrent",
        commandType: "country.adjust-resource",
        baseRevision: 2,
        payload: { resource: "treasuryTaels", delta: -1, reason: "并发推进" },
      },
    });
    expect(concurrent.statusCode).toBe(200);
    releaseProvider();

    const response = await responsePromise;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHARACTER_CONTEXT_STALE");
    const latest = system.meetings.getSession("meeting_stale");
    expect(latest?.status).toBe("waiting-for-agent");
    expect(latest?.pendingAgentAction?.actionId).toBe("act-stale");
    const agentTurns = system.meetings
      .listTurns("meeting_stale")
      .turns.filter((turn) => turn.actionId === "act-stale");
    expect(agentTurns).toEqual([]);
  });
});
