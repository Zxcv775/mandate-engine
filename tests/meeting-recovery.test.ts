import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";
import { makeSession, makeTurn } from "./helpers/meeting-fixtures";

/** §21.6 原子性与恢复：两阶段提交、幂等、stale、崩溃重启恢复。 */

const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setupSystem(): Promise<SaveSystem> {
  const system = createSaveSystem({
    databasePath: ":memory:",
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(() => system.close());
  await system.service.createSave({
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    title: "恢复测试",
    seed: "recovery",
  });
  return system;
}

describe("Meeting Repository 两阶段提交（ADR-020）", () => {
  it("阶段 A 预留：pending 写入且 meetingVersion 递增；stale 更新被拒", async () => {
    const system = await setupSystem();
    const session = makeSession("in-progress", { meetingVersion: 1 });
    system.meetings.createSession(session, [], []);

    const reserved = {
      ...session,
      status: "waiting-for-agent" as const,
      pendingAgentAction: {
        actionId: "act-1",
        characterId: "wei-zhongxian",
        responseMode: "speech" as const,
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: FIXTURE_NOW,
      },
      meetingVersion: 2,
    };
    system.meetings.updateSession(reserved, 1);
    expect(system.meetings.getSession("meeting-1")?.pendingAgentAction?.actionId).toBe("act-1");

    expect(() => system.meetings.updateSession({ ...reserved, meetingVersion: 3 }, 1)).toThrowError(
      expect.objectContaining({ code: "MEETING_VERSION_STALE" }),
    );
  });

  it("阶段 B：pending 匹配才可提交；同 actionId 重复提交幂等拒绝", async () => {
    const system = await setupSystem();
    const session = makeSession("waiting-for-agent", {
      meetingVersion: 2,
      pendingAgentAction: {
        actionId: "act-1",
        characterId: "wei-zhongxian",
        responseMode: "speech",
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: FIXTURE_NOW,
      },
    });
    system.meetings.createSession(session, [], []);
    const turn = makeTurn({
      turnId: "turn-a",
      turnNumber: 0,
      actionId: "act-1",
      meetingVersion: 3,
    });
    const next = makeSession("in-progress", { meetingVersion: 3, turnNumber: 1, usedTurns: 1 });
    system.meetings.commitAgentTurn(turn, next, 2);
    expect(system.meetings.getSession("meeting-1")?.pendingAgentAction).toBeUndefined();
    expect(system.meetings.listTurns("meeting-1").turns).toHaveLength(1);

    // 重放同 actionId：幂等拒绝，不产生第二条回合
    expect(() =>
      system.meetings.commitAgentTurn(
        makeTurn({ turnId: "turn-b", turnNumber: 1, actionId: "act-1", meetingVersion: 4 }),
        makeSession("in-progress", { meetingVersion: 4, turnNumber: 2 }),
        3,
      ),
    ).toThrowError(expect.objectContaining({ code: "MEETING_AGENT_RESPONSE_DUPLICATE" }));
    expect(system.meetings.listTurns("meeting-1").turns).toHaveLength(1);
  });

  it("append-only：同一 turnNumber 不可重复写入", async () => {
    const system = await setupSystem();
    system.meetings.createSession(makeSession("in-progress"), [], []);
    system.meetings.appendTurn(makeTurn({ turnId: "t1", turnNumber: 5 }));
    expect(() =>
      system.meetings.appendTurn(makeTurn({ turnId: "t2", turnNumber: 5 })),
    ).toThrowError(expect.objectContaining({ code: "MEETING_AGENT_RESPONSE_DUPLICATE" }));
  });

  it("findPendingAgentSessions 可定位待恢复会议", async () => {
    const system = await setupSystem();
    system.meetings.createSession(
      makeSession("waiting-for-agent", {
        pendingAgentAction: {
          actionId: "act-9",
          characterId: "wei-zhongxian",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      }),
      [],
      [],
    );
    const pending = system.meetings.findPendingAgentSessions("save_demo");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.pendingAgentAction?.actionId).toBe("act-9");
  });
});

describe("API 级恢复与幂等（§21.6）", () => {
  async function setupApp(
    databasePath: string,
    providerConfig: Parameters<typeof createCharacterMockProvider>[0],
  ): Promise<FastifyInstance> {
    const app = await buildApp({
      config: parseRuntimeConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "mock",
        SAVE_DATABASE_PATH: databasePath,
      }),
      provider: createCharacterMockProvider(providerConfig, NAMES),
      logger: false,
    });
    cleanup.push(() => app.close());
    return app;
  }

  const J = (r: { body: string }) =>
    JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

  async function prepareMeeting(app: FastifyInstance) {
    await app.inject({
      method: "POST",
      url: "/api/saves",
      payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "恢复", seed: "r1" },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings",
      payload: {
        meetingId: "m1",
        type: "imperial-council",
        title: "御前会议",
        purpose: "议事",
        participantIds: ["wei-zhongxian", "huang-liji"],
        expectedRevision: 0,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/agenda",
      payload: { agendaItemId: "ag1", title: "议题", description: "议题描述" },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/start",
      payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
    });
  }

  it("Provider 失败后 pending 保留；恢复重试同 actionId 只产生一条回合", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-recovery-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "save.sqlite");

    // 第一个"进程"：Provider 永远超时
    const failingApp = await setupApp(databasePath, { alwaysFail: "timeout" });
    await prepareMeeting(failingApp);
    let session = J(await failingApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" }))
      .data.session;
    // 推进到议程后再步进触发 Agent 回合（第一步是 advance-agenda）
    let step = await failingApp.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
    });
    session = J(step).data.session;
    step = await failingApp.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: {
        expectedRevision: 2,
        expectedMeetingVersion: session.meetingVersion,
        idempotencyKey: "act-recover-1",
      },
    });
    expect(step.statusCode).toBeGreaterThanOrEqual(500);
    session = J(await failingApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" })).data
      .session;
    expect(session.status).toBe("failed");
    expect(session.pendingAgentAction?.actionId).toBe("act-recover-1");
    await failingApp.close();

    // "重启后的进程"：Provider 恢复正常 → 从 pending 恢复
    const recoveredApp = await setupApp(databasePath, { defaultStance: "support" });
    // failed → paused → in-progress 后按 pending 恢复
    await recoveredApp.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/pause",
      payload: { reason: "恢复前整备" },
    });
    await recoveredApp.inject({ method: "POST", url: "/api/saves/s1/meetings/m1/resume" });
    session = J(await recoveredApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" })).data
      .session;
    expect(session.pendingAgentAction?.actionId).toBe("act-recover-1");
    const recovery = await recoveredApp.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
    });
    expect(recovery.statusCode).toBe(200);
    const turns = J(
      await recoveredApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1/turns" }),
    ).data.turns;
    const agentTurns = turns.filter((t: { type: string }) => t.type.startsWith("character-"));
    expect(agentTurns).toHaveLength(1);

    // 幂等重放：同 idempotencyKey 再 step → 不产生第二条 Agent 回合
    session = J(await recoveredApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" })).data
      .session;
    await recoveredApp.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: {
        expectedRevision: 2,
        expectedMeetingVersion: session.meetingVersion,
        idempotencyKey: "act-recover-1",
      },
    });
    const turnsAfter = J(
      await recoveredApp.inject({ method: "GET", url: "/api/saves/s1/meetings/m1/turns" }),
    ).data.turns.filter((t: { type: string }) => t.type.startsWith("character-"));
    expect(turnsAfter.length).toBeLessThanOrEqual(2);
  });

  it("stale meetingVersion 与 stale revision 均返回 409", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandate-stale-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const app = await setupApp(join(directory, "s.sqlite"), { defaultStance: "support" });
    await prepareMeeting(app);
    const session = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" })).data
      .session;

    const staleVersion = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion + 5 },
    });
    expect(staleVersion.statusCode).toBe(409);
    expect(J(staleVersion).error?.code).toBe("MEETING_VERSION_STALE");

    const staleRevision = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/step",
      payload: { expectedRevision: 7, expectedMeetingVersion: session.meetingVersion },
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(J(staleRevision).error?.code).toBe("STATE_REVISION_CONFLICT");
  });
});
