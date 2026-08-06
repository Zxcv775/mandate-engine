import { createCharacterMockProvider } from "@mandate/agent-runtime";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { meetingLabStore } from "../apps/web/src/store/meeting-lab-store";

/** P5.0：meeting.cancel REST 端点（命令层 Phase 4 已实现）与 Lab 参会复选框状态。 */

const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
};

let app: FastifyInstance;
const J = (r: { body: string }) =>
  JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

async function revision() {
  return J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data.revision as number;
}

async function createMeeting(meetingId: string, expectedRevision: number) {
  return app.inject({
    method: "POST",
    url: "/api/saves/s1/meetings",
    payload: {
      meetingId,
      type: "imperial-council",
      title: "待取消会议",
      purpose: "验证取消",
      participantIds: ["wei-zhongxian", "huang-liji"],
      expectedRevision,
    },
  });
}

beforeAll(async () => {
  app = await buildApp({
    config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
    provider: createCharacterMockProvider({ defaultStance: "support" }, NAMES),
    logger: false,
  });
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "取消", seed: "cancel" },
  });
});

afterAll(async () => {
  await app.close();
});

describe("POST /meetings/:meetingId/cancel（P5.0）", () => {
  it("scheduled 会议可取消：GameState 投影与会话态同步 cancelled，revision+1", async () => {
    const before = await revision();
    expect((await createMeeting("mc1", before)).statusCode).toBe(201);
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc1/cancel",
      payload: { expectedRevision: before + 1, reason: "圣意改期" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(J(cancelled).data.status).toBe("cancelled");
    expect(await revision()).toBe(before + 2);
    const projection = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .meetings.mc1;
    expect(projection.status).toBe("cancelled");
    const session = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/mc1" })).data
      .session;
    expect(session.status).toBe("cancelled");
  });

  it("in-progress 会议不可直接取消（须先暂停）→ 409 且状态不变", async () => {
    const before = await revision();
    await createMeeting("mc2", before);
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc2/start",
      payload: { expectedRevision: before + 1, expectedMeetingVersion: 1 },
    });
    const startedRevision = await revision();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc2/cancel",
      payload: { expectedRevision: startedRevision },
    });
    expect(rejected.statusCode).toBe(409);
    expect(J(rejected).error?.code).toBe("MEETING_INVALID_STATE");
    expect(await revision()).toBe(startedRevision);

    // 暂停后可取消
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc2/pause",
      payload: { reason: "取消前整备" },
    });
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc2/cancel",
      payload: { expectedRevision: startedRevision },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(J(cancelled).data.status).toBe("cancelled");
  });

  it("cancelled 终态不可再取消/开始；stale revision 返回 409", async () => {
    const again = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc1/cancel",
      payload: { expectedRevision: await revision() },
    });
    expect(again.statusCode).toBe(409);

    const restart = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc1/start",
      payload: { expectedRevision: await revision(), expectedMeetingVersion: 2 },
    });
    expect(restart.statusCode).toBe(409);

    const before = await revision();
    await createMeeting("mc3", before);
    const stale = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/mc3/cancel",
      payload: { expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(J(stale).error?.code).toBe("STATE_REVISION_CONFLICT");
  });

  it("不存在的会议返回 404", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/nope/cancel",
      payload: { expectedRevision: await revision() },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("Meeting Lab 参会复选框状态（P5.0）", () => {
  it("toggleParticipant 幂等往返：勾选→取消→再勾选", () => {
    meetingLabStore.setState({ selectedParticipants: ["wei-zhongxian", "huang-liji"] });
    const store = meetingLabStore.getState();
    store.toggleParticipant("huang-liji");
    expect(meetingLabStore.getState().selectedParticipants).toEqual(["wei-zhongxian"]);
    meetingLabStore.getState().toggleParticipant("huang-liji");
    expect(meetingLabStore.getState().selectedParticipants).toEqual([
      "wei-zhongxian",
      "huang-liji",
    ]);
    meetingLabStore.getState().toggleParticipant("wei-zhongxian");
    meetingLabStore.getState().toggleParticipant("huang-liji");
    expect(meetingLabStore.getState().selectedParticipants).toEqual([]);
  });
});
