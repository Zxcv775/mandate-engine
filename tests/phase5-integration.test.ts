import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

/** §二十一 Phase 5 最小可玩闭环：会议→政策 + 直诏→偏差→废止→导入导出。 */

const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
};

let directory: string;
let databasePath: string;
let app: FastifyInstance;
const J = (r: { body: string }) =>
  JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

async function revision() {
  return J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data.revision as number;
}

async function advanceDays(days: number) {
  const before = await revision();
  const result = await app.inject({
    method: "POST",
    url: "/api/saves/s1/time/advance",
    payload: { commandId: `cmd_adv_${before}`, baseRevision: before, days },
  });
  expect(result.statusCode).toBe(200);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mandate-p5-int-"));
  databasePath = join(directory, "save.sqlite");
  app = await buildApp({
    config: parseRuntimeConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
      SAVE_DATABASE_PATH: databasePath,
    }),
    provider: createCharacterMockProvider(
      { defaultStance: "support", byCharacterId: { "wang-cheng-en": "oppose" } },
      NAMES,
    ),
    logger: false,
  });
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "P5 闭环", seed: "p5-loop" },
  });
});

afterAll(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe("闭环一：会议「陕西赈灾」→ propose-policy 候选 → 御批颁行 → 结算（§二十一）", () => {
  let policyId: string;

  it("会议荐策产生可映射候选，准行即创建政策草案（会议来源）", async () => {
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings",
      payload: {
        meetingId: "m-zhenzai",
        type: "imperial-council",
        title: "议陕西赈灾",
        purpose: "议陕西旱灾赈济事",
        participantIds: ["huang-liji", "cui-chengxiu"],
        expectedRevision: 0,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m-zhenzai/agenda",
      payload: {
        agendaItemId: "ag-zhenzai",
        title: "陕西旱灾如何赈济",
        description: "秦地亢旱，饥民流离，当议赈济之策",
        relatedEntityIds: ["policy-zhenji-shaanxi"],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m-zhenzai/start",
      payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
    });

    // 推进至有 propose-policy 候选（黄立极/崔呈秀 support → recommend-policy）
    let session = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m-zhenzai" }))
      .data.session;
    for (let index = 0; index < 6; index++) {
      const step = await app.inject({
        method: "POST",
        url: "/api/saves/s1/meetings/m-zhenzai/step",
        payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
      });
      if (step.statusCode !== 200) break;
      session = J(step).data.session;
      const outcomes = J(
        await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m-zhenzai/outcomes" }),
      ).data as Array<{ unsupportedCommand: boolean }>;
      if (outcomes.some((candidate) => !candidate.unsupportedCommand)) break;
    }
    const outcomes = J(
      await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m-zhenzai/outcomes" }),
    ).data as Array<{
      outcomeCandidateId: string;
      agendaItemId: string;
      type: string;
      unsupportedCommand: boolean;
      commandPreview?: { commandType: string; payload: { templateId: string } };
    }>;
    const mappable = outcomes.find(
      (candidate) =>
        !candidate.unsupportedCommand && candidate.commandPreview?.commandType === "policy.propose",
    );
    expect(mappable).toBeDefined();
    expect(mappable!.commandPreview!.payload.templateId).toBe("policy-zhenji-shaanxi");

    // 准行 → policy.propose（恰一条命令，revision+1）
    const before = await revision();
    session = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m-zhenzai" })).data
      .session;
    const ruling = await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m-zhenzai/rulings",
      payload: {
        expectedRevision: before,
        expectedMeetingVersion: session.meetingVersion,
        agendaItemId: mappable!.agendaItemId,
        selectedOutcomeCandidateIds: [mappable!.outcomeCandidateId],
        text: "准行赈济",
      },
    });
    expect(ruling.statusCode).toBe(200);
    expect(J(ruling).data.acceptedCommands).toBe(1);
    expect(await revision()).toBe(before + 1);

    const policies = J(await app.inject({ method: "GET", url: "/api/saves/s1/policies" }))
      .data as Array<{ policyId: string; status: string; origin: { kind: string } }>;
    expect(policies).toHaveLength(1);
    policyId = policies[0]!.policyId;
    expect(policies[0]).toMatchObject({
      status: "proposed",
      origin: { kind: "meeting" },
    });
  });

  it("御批 → 颁行（指派户部/黄立极）→ 会议结束 → 推进 3 tick：进度/扣款/奏报流", async () => {
    let current = await revision();
    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/decision`,
      payload: { decision: "approve", expectedRevision: current },
    });
    current = await revision();
    const treasuryBefore = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .country.treasuryTaels as number;
    const issued = await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/issue`,
      payload: {
        expectedRevision: current,
        responsibleInstitutionId: "hu-bu",
        responsibleCharacterIds: ["huang-liji"],
        additionalBudget: { treasuryTaels: 50_000 },
      },
    });
    expect(issued.statusCode).toBe(200);
    expect(J(issued).data.status).toBe("issued");
    const treasuryAfterIssue = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" }))
      .data.country.treasuryTaels as number;
    // 启动银 12 万 + 追加 5 万
    expect(treasuryBefore - treasuryAfterIssue).toBe(170_000);

    // 结束会议（会议命令与政策命令互不越权）
    const session = J(await app.inject({ method: "GET", url: "/api/saves/s1/meetings/m-zhenzai" }))
      .data.session;
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/meetings/m-zhenzai/conclude",
      payload: {
        expectedRevision: await revision(),
        expectedMeetingVersion: session.meetingVersion,
      },
    });

    for (let day = 0; day < 3; day++) {
      await advanceDays(1);
    }
    const policy = J(
      await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` }),
    ).data;
    expect(policy.status).toBe("implementing");
    expect(policy.stageProgress).toBeGreaterThan(0);
    // 维持成本从追加预算扣
    expect(policy.remainingBudget.treasuryTaels).toBe(50_000 - 800 * 3);
    const reports = J(
      await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}/reports` }),
    ).data.reports as Array<{ text: string }>;
    expect(reports.length).toBe(3);
    expect(reports.every((report) => !report.text.includes("核实进度"))).toBe(true);
  });

  it("Debug 对比真实与奏报 → adjust 追加预算 → 大步推进至完成，留下长期 Modifier", async () => {
    const truth = J(
      await app.inject({
        method: "GET",
        url: `/api/debug/saves/s1/policies/${policyId}/truth`,
      }),
    ).data;
    expect(truth.truth.realStageProgress).toBeGreaterThanOrEqual(0);

    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/adjust`,
      payload: {
        expectedRevision: await revision(),
        additionalBudget: { treasuryTaels: 100_000, grainReserveShi: 100_000 },
        reason: "加拨赈银赈粮",
      },
    });

    // 大步推进直至完成（确定性；上限防御死循环）
    for (let round = 0; round < 12; round++) {
      const policy = J(
        await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` }),
      ).data;
      if (policy.status === "completed") break;
      await advanceDays(30);
    }
    const final = J(
      await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` }),
    ).data;
    expect(final.status).toBe("completed");
    expect(final.overallProgress).toBe(100);

    // 完成留下长期 Modifier（unique-by-source 稳定度 +2）
    const state = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data;
    const modifiers = Object.values(
      state.modifiers as Record<
        string,
        { source: { kind: string; policyId?: string }; metric: string }
      >,
    );
    expect(
      modifiers.some(
        (modifier) => modifier.source.policyId === policyId && modifier.metric === "stability",
      ),
    ).toBe(true);
  });
});

describe("闭环二：直诏「清查京营占役」→ 偏差 → 暂停/复行/废止 → 导入导出（§二十一）", () => {
  const policyId = "p-jingying";

  it("直诏承担合法性代价；指派低忠诚负责人颁行", async () => {
    let current = await revision();
    const legitimacyBefore = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .country.legitimacy as number;
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: {
        policyId,
        templateId: "policy-qingcha-jingying",
        expectedRevision: current,
      },
    });
    current = await revision();
    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/decision`,
      payload: { decision: "approve", expectedRevision: current },
    });
    const legitimacyAfter = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .country.legitimacy as number;
    // 模板 baseImpact +1、直诏规则 -2 → 净 -1（跳过朝议的可计算代价）
    expect(legitimacyAfter).toBe(legitimacyBefore + 1 - 2);

    // 低忠诚负责人（魏忠贤 loyalty 20）为首，崔呈秀（兵部尚书）保资格
    const issued = await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/issue`,
      payload: {
        expectedRevision: await revision(),
        responsibleInstitutionId: "bing-bu",
        responsibleCharacterIds: ["cui-chengxiu"],
        additionalBudget: { treasuryTaels: 50_000 },
      },
    });
    expect(issued.statusCode).toBe(200);
  });

  it("推进触发执行偏差：玩家进度与 Debug 真实进度分离（实测断言）", async () => {
    for (let day = 0; day < 20; day++) {
      await advanceDays(1);
    }
    const truth = J(
      await app.inject({
        method: "GET",
        url: `/api/debug/saves/s1/policies/${policyId}/truth`,
      }),
    ).data;
    // 低忠诚 + 高道德弹性负责人：20 tick 内确定性触发偏差
    expect(truth.deviations.length).toBeGreaterThan(0);
    const publicPolicy = J(
      await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` }),
    ).data;
    // 奏报口径与真实口径分离（拖延/造假/表面完成等任一都会造成分歧）
    expect(publicPolicy.stageProgress).not.toBe(truth.truth.realStageProgress);
    // 玩家 API 不暴露真实值
    expect(JSON.stringify(publicPolicy)).not.toContain("realStageProgress");
  });

  it("suspend → resume → cancel：沉没成本结算正确", async () => {
    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/suspend`,
      payload: { expectedRevision: await revision(), reason: "廷议復核" },
    });
    let policy = J(
      await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` }),
    ).data;
    expect(policy.status).toBe("suspended");

    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/resume`,
      payload: { expectedRevision: await revision() },
    });
    policy = J(await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` })).data;
    expect(policy.status).toBe("implementing");

    const treasuryBefore = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .country.treasuryTaels as number;
    const remaining = policy.remainingBudget.treasuryTaels as number;
    await app.inject({
      method: "POST",
      url: `/api/saves/s1/policies/${policyId}/cancel`,
      payload: { expectedRevision: await revision(), reason: "查无实效，罢之" },
    });
    policy = J(await app.inject({ method: "GET", url: `/api/saves/s1/policies/${policyId}` })).data;
    expect(policy.status).toBe("cancelled");
    expect(policy.remainingBudget.treasuryTaels).toBe(0);
    const treasuryAfter = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data
      .country.treasuryTaels as number;
    // 未耗预算退还；已投入沉没
    expect(treasuryAfter).toBe(treasuryBefore + remaining);
  });

  it("存档导出 → 全新库导入：政策状态与明细完整（含 hidden 真实档案）", async () => {
    const exported = await app.inject({
      method: "POST",
      url: "/api/saves/s1/export",
      payload: { includeSourceMetadata: true, safeShareMode: "none" },
    });
    expect(exported.statusCode).toBe(200);
    const packageBase64 = J(exported).data.packageBase64 as string;

    const targetDirectory = await mkdtemp(join(tmpdir(), "mandate-p5-import-"));
    const target = createSaveSystem({
      databasePath: join(targetDirectory, "t.sqlite"),
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    try {
      await target.service.importSave({
        bytes: Buffer.from(packageBase64, "base64"),
      });
      const state = await target.service.loadState("s1");
      expect(Object.keys(state.policies).length).toBeGreaterThanOrEqual(2);
      expect(state.policies[policyId]!.status).toBe("cancelled");
      expect(state.hidden.policyTruth[policyId]).toBeDefined();
      expect(target.policyDetails.listStageResults("s1", policyId).length).toBeGreaterThan(0);
      expect(target.policyDetails.listDeviations("s1", policyId).length).toBeGreaterThan(0);
    } finally {
      target.close();
      await rm(targetDirectory, { recursive: true, force: true });
    }
  });
});
