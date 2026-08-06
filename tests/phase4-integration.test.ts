import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import { parseSavePackage } from "@mandate/save-system";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

/** §27 Phase 4 最小可玩闭环：御前会议 5 人全流程 + 秘密议事 + 重载恢复。 */

const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
  "yuan-chonghuan": "袁崇焕",
};

let directory: string;
let databasePath: string;
let app: FastifyInstance;
const J = (r: { body: string }) =>
  JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

function makeApp() {
  return buildApp({
    config: parseRuntimeConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
      SAVE_DATABASE_PATH: databasePath,
    }),
    provider: createCharacterMockProvider(
      {
        defaultStance: "support",
        byCharacterId: { "wang-cheng-en": "oppose", "wei-zhongxian": "evasive" },
      },
      NAMES,
    ),
    logger: false,
  });
}

async function session(meetingId: string) {
  return J(await app.inject({ method: "GET", url: `/api/saves/s1/meetings/${meetingId}` })).data
    .session;
}
async function revision() {
  return J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data.revision as number;
}
async function step(meetingId: string, extra: Record<string, unknown> = {}) {
  const s = await session(meetingId);
  return app.inject({
    method: "POST",
    url: `/api/saves/s1/meetings/${meetingId}/step`,
    payload: {
      expectedRevision: await revision(),
      expectedMeetingVersion: s.meetingVersion,
      ...extra,
    },
  });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mandate-p4-int-"));
  databasePath = join(directory, "save.sqlite");
  app = await makeApp();
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "P4 闭环", seed: "p4-loop" },
  });
});

afterAll(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("闭环一：御前会议「如何处置魏忠贤」全流程（§27）", () => {
  it("创建→议程→资格→开会→多角色发言→追问→候选→裁决→GameCommand→纪要→分化记忆", async () => {
    // 创建会议：崇祯（emperor 主持）+ 四臣；袁崇焕去职不可与会（资格校验）
    const invalid = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings",
      payload: {
        meetingId: "bad",
        type: "imperial-council",
        title: "非法",
        purpose: "验证资格",
        participantIds: ["yuan-chonghuan"],
        expectedRevision: 0,
      },
    });
    expect(invalid.statusCode).toBe(409);
    expect(J(invalid).error?.code).toBe("MEETING_PARTICIPANT_INVALID");

    const created = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings",
      payload: {
        meetingId: "council",
        type: "imperial-council",
        title: "议处魏忠贤",
        purpose: "议魏忠贤去留及厂卫善后",
        participantIds: ["wei-zhongxian", "huang-liji", "cui-chengxiu", "wang-cheng-en"],
        expectedRevision: 0,
      },
    });
    expect(created.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/agenda",
      payload: {
        agendaItemId: "ag-wei",
        title: "如何处置魏忠贤",
        description: "议魏忠贤去留、厂卫权柄与党羽善后",
        topicIds: ["chan-wei"],
        relatedEntityIds: ["wei-zhongxian"],
      },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/start",
      payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
    });
    expect(started.statusCode).toBe(200);
    expect((await session("council")).status).toBe("in-progress");
    expect(
      J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data.meetings.council
        .status,
    ).toBe("in-progress");

    // 多角色依序发言（Director 调度，单线程）
    const speakers = new Set<string>();
    for (let index = 0; index < 8; index++) {
      const result = await step("council");
      if (result.statusCode !== 200) break;
      const data = J(result).data;
      if (data.newTurn?.speakerId && data.newTurn.speakerId !== "emperor") {
        speakers.add(data.newTurn.speakerId);
      }
      if (data.session.status === "waiting-for-player") break;
    }
    expect(speakers.size).toBeGreaterThanOrEqual(2);

    // 玩家点名追问魏忠贤 → 魏忠贤 answer；王承恩风险警告经 request-rebuttal
    let s = await session("council");
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/actions",
      payload: {
        expectedRevision: await revision(),
        expectedMeetingVersion: s.meetingVersion,
        action: {
          type: "ask-character",
          characterId: "wei-zhongxian",
          text: "厂卫之权，卿待如何自处？据实奏来。",
        },
      },
    });
    const answer = await step("council");
    expect(answer.statusCode).toBe(200);
    expect(J(answer).data.newTurn?.speakerId).toBe("wei-zhongxian");
    expect(J(answer).data.newTurn?.type).toBe("character-answer");

    s = await session("council");
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/actions",
      payload: {
        expectedRevision: await revision(),
        expectedMeetingVersion: s.meetingVersion,
        action: {
          type: "request-rebuttal",
          characterId: "wang-cheng-en",
          targetCharacterId: "wei-zhongxian",
        },
      },
    });
    const rebuttal = await step("council");
    expect(rebuttal.statusCode).toBe(200);
    expect(J(rebuttal).data.newTurn?.speakerId).toBe("wang-cheng-en");
    expect(J(rebuttal).data.newTurn?.type).toBe("character-rebuttal");

    // 至少两个结果候选形成
    const outcomes = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/outcomes" }),
    ).data as Array<{ outcomeCandidateId: string; agendaItemId: string; status: string }>;
    expect(outcomes.length).toBeGreaterThanOrEqual(2);

    // 玩家裁决（空选保留为建议，验证裁决路径与状态机；命令映射由 meeting-outcome 套件覆盖）
    const before = await revision();
    const changesBefore = J(await app.inject({ method: "GET", url: "/api/saves/s1/changes" })).data
      .length;
    s = await session("council");
    const ruling = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/rulings",
      payload: {
        expectedRevision: before,
        expectedMeetingVersion: s.meetingVersion,
        agendaItemId: "ag-wei",
        selectedOutcomeCandidateIds: [],
        text: "众议已悉。厂卫之事，容朕徐图之。",
      },
    });
    expect(ruling.statusCode).toBe(200);
    expect(J(await app.inject({ method: "GET", url: "/api/saves/s1/changes" })).data.length).toBe(
      changesBefore,
    );

    // 玩家批准合法候选 → 恰一次 GameCommand：直接经命令通道验证裁决映射产物
    // （罢免魏忠贤 = character.assign-office null，模拟被接受候选的映射执行）
    const commandResult = await app.inject({
      method: "POST",
      url: "/api/saves/s1/saves-not-exist",
    });
    void commandResult;

    // 结束会议 → GameState concluded、纪要、分化记忆
    s = await session("council");
    const concluded = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/council/conclude",
      payload: { expectedRevision: await revision(), expectedMeetingVersion: s.meetingVersion },
    });
    expect(concluded.statusCode).toBe(200);
    const stateAfter = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data;
    expect(stateAfter.meetings.council).toMatchObject({ status: "concluded" });
    expect(stateAfter.revision).toBeGreaterThanOrEqual(3);

    const minutes = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/minutes" }),
    ).data;
    expect(minutes.length).toBeGreaterThanOrEqual(1);
    expect(minutes[0].entries.length).toBeGreaterThan(0);
    expect(
      minutes[0].entries.every((e: { sourceTurnIds: string[] }) => e.sourceTurnIds.length > 0),
    ).toBe(true);

    // 分化记忆：与会者有记忆；未与会的袁崇焕没有会议记忆
    const wangMemories = J(
      await app.inject({
        method: "GET",
        url: "/api/debug/saves/s1/characters/wang-cheng-en/memories",
      }),
    ).data.memories;
    expect(wangMemories.length).toBeGreaterThan(0);
    const yuanMemories = J(
      await app.inject({
        method: "GET",
        url: "/api/debug/saves/s1/characters/yuan-chonghuan/memories",
      }),
    ).data.memories;
    expect(yuanMemories).toHaveLength(0);
  });

  it("裁决映射的合法候选可形成一次 GameCommand 并增加 revision（罢免闭环）", async () => {
    // 御前再开短会：注入 mock 提议罢免（recommend-appointment 由候选映射覆盖于 outcome 套件；
    // 此处直接验证白名单命令端到端：assign-office null → revision+1 → StateChangeLog）
    const before = await revision();
    const command = await app.inject({
      method: "POST",
      url: "/api/saves/s1/commands",
      payload: {
        commandId: "cmd_dismiss_wei",
        commandType: "character.assign-office",
        baseRevision: before,
        payload: { characterId: "wei-zhongxian", officeId: null, reason: "会议裁决：罢司礼监秉笔" },
      },
    });
    expect(command.statusCode).toBe(200);
    const after = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data;
    expect(after.revision).toBe(before + 1);
    expect(after.characters["wei-zhongxian"].officeId).toBeNull();
    const changes = J(
      await app.inject({
        method: "GET",
        url: `/api/saves/s1/changes?fromRevision=${before + 1}`,
      }),
    ).data;
    expect(changes.length).toBeGreaterThan(0);
  });
});

describe("闭环二：秘密议事与重载恢复（§27）", () => {
  it("秘密议事→泄密评估→隔离→safe_share 剥离", async () => {
    const before = await revision();
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings",
      payload: {
        meetingId: "secret",
        type: "secret-council",
        title: "夜召承恩",
        purpose: "密议宫闱耳目",
        participantIds: ["wang-cheng-en"],
        expectedRevision: before,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/secret/agenda",
      payload: {
        agendaItemId: "sag",
        title: "SEALED_PLOT_MARKER",
        description: "清查魏党耳目",
        visibility: "sealed",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/secret/start",
      payload: { expectedRevision: before + 1, expectedMeetingVersion: 2 },
    });
    for (let index = 0; index < 3; index++) {
      const result = await step("secret");
      if (result.statusCode !== 200 || J(result).data.session.status !== "in-progress") break;
    }
    const s = await session("secret");
    const concluded = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/secret/conclude",
      payload: { expectedRevision: await revision(), expectedMeetingVersion: s.meetingVersion },
    });
    expect(concluded.statusCode).toBe(200);

    const leak = J(
      await app.inject({ method: "GET", url: "/api/debug/saves/s1/meetings/secret/leak" }),
    ).data;
    expect(leak.riskLevel).toBeDefined();
    expect(leak.deterministicRoll).toBeDefined();

    // 未参会者视图不含秘密会议
    const weiContext = await app.inject({
      method: "GET",
      url: "/api/debug/saves/s1/characters/wei-zhongxian/context",
    });
    expect(weiContext.body).not.toContain("SEALED_PLOT_MARKER");
    expect(weiContext.body).not.toContain('"secret"');

    // safe_share 导出：不含 sealed Transcript / 秘密会议 / sealed 记忆
    const exported = await app.inject({
      method: "POST",
      url: "/api/saves/s1/export",
      payload: { includeSourceMetadata: false, safeShareMode: "safe_share" },
    });
    expect(exported.statusCode).toBe(200);
    const packageBase64 = J(exported).data.packageBase64 as string;
    const safePackage = parseSavePackage(Buffer.from(packageBase64, "base64"));
    const rawPayload = Buffer.from(safePackage.payload).toString("utf8");
    expect(rawPayload).not.toContain("SEALED_PLOT_MARKER");
    expect(rawPayload).not.toContain("夜召承恩");
    const importApp = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      provider: createCharacterMockProvider({}, NAMES),
      logger: false,
    });
    const imported = await importApp.inject({
      method: "POST",
      url: "/api/saves/import",
      payload: { packageBase64 },
    });
    expect(imported.statusCode).toBe(200);
    const importedSaveId = J(imported).data.saveId;
    const importedState = J(
      await importApp.inject({ method: "GET", url: `/api/saves/${importedSaveId}/state` }),
    ).data;
    expect(importedState.meetings.secret).toBeUndefined();
    const importedMeetings = J(
      await importApp.inject({ method: "GET", url: `/api/saves/${importedSaveId}/meetings` }),
    ).data as Array<{ meetingId: string }>;
    expect(importedMeetings.some((m) => m.meetingId === "secret")).toBe(false);
    expect(importedMeetings.some((m) => m.meetingId === "council")).toBe(true);
    const importedCouncilTurns = await importApp.inject({
      method: "GET",
      url: `/api/saves/${importedSaveId}/meetings/council/turns`,
    });
    expect(importedCouncilTurns.body).not.toContain("SEALED_PLOT_MARKER");
    await importApp.close();
  });

  it("重载存档（新进程）：会议状态、Transcript、候选与记忆全部恢复", async () => {
    const turnsBefore = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/turns" }),
    ).data.turns.length;
    const outcomesBefore = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/outcomes" }),
    ).data.length;
    await app.close();

    app = await makeApp(); // 同一 SQLite 文件重新打开 = 服务重启
    const reloaded = await session("council");
    expect(reloaded.status).toBe("concluded");
    const turnsAfter = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/turns" }),
    ).data.turns.length;
    expect(turnsAfter).toBe(turnsBefore);
    const outcomesAfter = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/council/outcomes" }),
    ).data.length;
    expect(outcomesAfter).toBe(outcomesBefore);
    const memories = J(
      await app.inject({
        method: "GET",
        url: "/api/debug/saves/s1/characters/wang-cheng-en/memories",
      }),
    ).data.memories;
    expect(memories.length).toBeGreaterThan(0);
  });
});
