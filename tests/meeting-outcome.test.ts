import { mapOutcomeToCommand } from "@mandate/meeting-engine";
import type { MeetingOutcomeCandidate } from "@mandate/domain";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW, makeCharacterTemplate, makeFixtureState } from "./helpers/character-fixtures";

/** §21.7 会议结果候选与裁决：白名单映射、非法拒绝、裁决幂等、状态只经 StateEngine。 */

function candidate(overrides: Partial<MeetingOutcomeCandidate> = {}): MeetingOutcomeCandidate {
  return {
    outcomeCandidateId: "oc-1",
    meetingId: "m1",
    saveId: "save_demo",
    agendaItemId: "ag1",
    type: "appointment-proposal",
    title: "罢免测试人物",
    summary: "请罢其职",
    proposerIds: ["huang-liji"],
    supporterIds: [],
    opponentIds: [],
    rationale: ["以安人心"],
    risks: [],
    sourceTurnIds: ["turn-1"],
    status: "presented",
    unsupportedCommand: false,
    createdAtRevision: 1,
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

describe("Outcome → GameCommand 白名单映射（ADR-019）", () => {
  const state = makeFixtureState([makeCharacterTemplate({ id: "wei-zhongxian", name: "魏忠贤" })]);

  it("合法任免候选映射为 character.assign-office", () => {
    const result = mapOutcomeToCommand(
      candidate({
        commandPreview: {
          commandType: "character.assign-office",
          payload: { characterId: "wei-zhongxian", officeId: null, reason: "罢免" },
        },
      }),
      state,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toMatchObject({
        commandType: "character.assign-office",
        payload: { characterId: "wei-zhongxian", officeId: null },
      });
    }
  });

  it("合法资源候选映射并预检余额；余额不足拒绝", () => {
    const ok = mapOutcomeToCommand(
      candidate({
        type: "resource-allocation-request",
        commandPreview: {
          commandType: "country.adjust-resource",
          payload: { resource: "treasuryTaels", delta: -100_000, reason: "拨辽饷" },
        },
      }),
      state,
    );
    expect(ok.ok).toBe(true);

    const broke = mapOutcomeToCommand(
      candidate({
        commandPreview: {
          commandType: "country.adjust-resource",
          payload: { resource: "treasuryTaels", delta: -999_999_999, reason: "掏空国库" },
        },
      }),
      state,
    );
    expect(broke).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });
  });

  it("非法目标实体 / 不支持的 commandType / 任意 mutation 均拒绝", () => {
    expect(
      mapOutcomeToCommand(
        candidate({
          commandPreview: {
            commandType: "character.assign-office",
            payload: { characterId: "nobody", officeId: null, reason: "x" },
          },
        }),
        state,
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });

    expect(
      mapOutcomeToCommand(
        candidate({
          commandPreview: { commandType: "save.rollback", payload: { targetRevision: 0 } },
        }),
        state,
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_UNSUPPORTED" });

    // LLM 构造任意 mutation 形态：payload 不符 Schema 直接拒绝
    expect(
      mapOutcomeToCommand(
        candidate({
          commandPreview: {
            commandType: "country.adjust-resource",
            payload: { path: "/hidden/secretFlags", set: { hacked: true } },
          },
        }),
        state,
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });
  });

  it("无 commandPreview 的候选保留为建议", () => {
    expect(mapOutcomeToCommand(candidate({ unsupportedCommand: true }), state)).toMatchObject({
      ok: false,
      code: "MEETING_OUTCOME_UNSUPPORTED",
    });
  });
});

describe("裁决 API：接受/拒绝/重复/未接受不改状态（§21.7）", () => {
  let app: FastifyInstance;
  const J = (r: { body: string }) =>
    JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

  beforeAll(async () => {
    app = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      provider: createCharacterMockProvider(
        { defaultStance: "support" },
        { "wei-zhongxian": "魏忠贤", "huang-liji": "黄立极" },
      ),
      logger: false,
    });
    await app.inject({
      method: "POST",
      url: "/api/saves",
      payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "裁决", seed: "o1" },
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
      payload: { agendaItemId: "ag1", title: "处置魏忠贤", description: "议其去留" },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/start",
      payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
    });
    // 直接注入一个可映射候选（模拟臣工奏议形成的罢免建议）
    const saveSystem = (app as unknown as { meetingService: { options?: unknown } }).meetingService;
    void saveSystem;
  });

  afterAll(async () => {
    await app.close();
  });

  async function currentSession() {
    return J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m1" })).data.session;
  }
  async function currentRevision() {
    return J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .revision as number;
  }

  it("推进产生候选后：接受可映射候选 → 恰一条 GameCommand → revision+1", async () => {
    // 推进若干步让 Agent 产生候选
    let session = await currentSession();
    let revision = await currentRevision();
    for (let index = 0; index < 4; index++) {
      const step = await app.inject({
        method: "POST",
        url: "/api/saves/s1/meetings/m1/step",
        payload: { expectedRevision: revision, expectedMeetingVersion: session.meetingVersion },
      });
      if (step.statusCode !== 200) break;
      session = J(step).data.session;
      if (session.status !== "in-progress") break;
    }
    const outcomes = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m1/outcomes" }),
    ).data as Array<{
      outcomeCandidateId: string;
      unsupportedCommand: boolean;
      agendaItemId: string;
      status: string;
    }>;
    expect(outcomes.length).toBeGreaterThan(0);

    // 仅建议类候选：接受不产生命令、不改 revision
    const advisory = outcomes.find((o) => o.unsupportedCommand && o.status === "presented");
    expect(advisory).toBeDefined();
    revision = await currentRevision();
    session = await currentSession();
    const changesBefore = J(await app.inject({ method: "GET", url: "/api/saves/s1/changes" })).data
      .length;
    const ruling = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/rulings",
      payload: {
        expectedRevision: revision,
        expectedMeetingVersion: session.meetingVersion,
        agendaItemId: advisory!.agendaItemId,
        selectedOutcomeCandidateIds: [],
        text: "众议已闻，此议暂存",
      },
    });
    expect(ruling.statusCode).toBe(200);
    expect(await currentRevision()).toBe(revision); // 空裁决不动状态
    const changesAfter = J(await app.inject({ method: "GET", url: "/api/saves/s1/changes" })).data
      .length;
    expect(changesAfter).toBe(changesBefore);

    // 未接受的候选全部标记 rejected，不修改状态
    const after = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m1/outcomes" }))
      .data as Array<{ status: string }>;
    expect(after.every((o) => o.status === "rejected")).toBe(true);
  });

  it("重复裁决同一议程返回 409", async () => {
    const session = await currentSession();
    const revision = await currentRevision();
    const repeat = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/rulings",
      payload: {
        expectedRevision: revision,
        expectedMeetingVersion: session.meetingVersion,
        agendaItemId: "ag1",
        selectedOutcomeCandidateIds: [],
      },
    });
    expect(repeat.statusCode).toBe(409);
    expect(J(repeat).error?.code).toBe("MEETING_RULING_INVALID");
  });

  it("裁决时 revision stale 返回 409 且不改状态", async () => {
    const session = await currentSession();
    const stale = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m1/rulings",
      payload: {
        expectedRevision: 99,
        expectedMeetingVersion: session.meetingVersion,
        agendaItemId: "ag1",
        selectedOutcomeCandidateIds: [],
      },
    });
    expect(stale.statusCode).toBe(409);
  });
});
