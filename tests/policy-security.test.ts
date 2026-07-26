import { createCharacterMockProvider } from "@mandate/agent-runtime";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

/** §21.8 政策安全：恶意输入矩阵扩展——全部被拒且 revision 不变、StateChangeLog 零新增。 */

const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
};

let app: FastifyInstance;
const J = (r: { body: string }) =>
  JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse>; error?: { code: string } };

async function revision() {
  return J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data.revision as number;
}
async function changeCount() {
  return J(await app.inject({ method: "GET", url: "/api/saves/s1/changes" })).data.length as number;
}

beforeAll(async () => {
  app = await buildApp({
    config: parseRuntimeConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
      LLM_API_KEY: "sk-policy-secret-key",
    }),
    provider: createCharacterMockProvider({ defaultStance: "support" }, NAMES),
    logger: false,
  });
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: { saveId: "s1", scenarioId: "chongzhen-early", title: "安全", seed: "psec" },
  });
});

afterAll(async () => {
  await app.close();
});

describe("政策恶意输入矩阵（§十三.8）", () => {
  it("伪造 templateId 直诏：404 且状态零变化", async () => {
    const before = await revision();
    const changesBefore = await changeCount();
    const forged = await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: { templateId: "policy-forged-by-llm", expectedRevision: before },
    });
    expect(forged.statusCode).toBe(404);
    expect(J(forged).error?.code).toBe("POLICY_TEMPLATE_NOT_FOUND");
    expect(await revision()).toBe(before);
    expect(await changeCount()).toBe(changesBefore);
  });

  it("SQL 注入串作 templateId：不执行、404、库表完好", async () => {
    const before = await revision();
    const sql = await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: {
        templateId: "x'; DROP TABLE saves; --",
        expectedRevision: before,
      },
    });
    expect(sql.statusCode).toBe(404);
    expect(await revision()).toBe(before);
    // saves 表仍在（后续查询正常）
    const saves = await app.inject({ method: "GET", url: "/api/saves" });
    expect(saves.statusCode).toBe(200);
  });

  it("请求体夹带任意 mutation/effect 字段：VALIDATION_ERROR", async () => {
    const before = await revision();
    const injected = await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: {
        templateId: "policy-zhenji-shaanxi",
        expectedRevision: before,
        mutations: [{ path: "/country/treasuryTaels", set: 999999999 }],
      },
    });
    expect(injected.statusCode).toBe(400);
    expect(J(injected).error?.code).toBe("VALIDATION_ERROR");
    expect(await revision()).toBe(before);
  });

  it("负成本/负预算：Schema 拒绝", async () => {
    const before = await revision();
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: {
        policyId: "psec-1",
        templateId: "policy-zhenji-shaanxi",
        expectedRevision: before,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies/psec-1/decision",
      payload: { decision: "approve", expectedRevision: before + 1 },
    });
    const negative = await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies/psec-1/issue",
      payload: {
        expectedRevision: await revision(),
        responsibleInstitutionId: "hu-bu",
        responsibleCharacterIds: ["huang-liji"],
        additionalBudget: { treasuryTaels: -50_000 },
      },
    });
    expect(negative.statusCode).toBe(400);
    expect(J(negative).error?.code).toBe("VALIDATION_ERROR");
  });

  it("玩家命令通道不得直呼 policy.resolve-tick（Debug 专用）", async () => {
    const before = await revision();
    const direct = await app.inject({
      method: "POST",
      url: "/api/saves/s1/commands",
      payload: {
        commandId: "cmd_hack",
        commandType: "policy.resolve-tick",
        baseRevision: before,
        payload: {},
      },
    });
    expect(direct.statusCode).toBe(400);
    expect(await revision()).toBe(before);
  });

  it("响应不泄露 API Key 与 hidden 真实值结构", async () => {
    const list = await app.inject({ method: "GET", url: "/api/saves/s1/policies" });
    const state = await app.inject({ method: "GET", url: "/api/saves/s1/state" });
    const body = list.body + state.body;
    expect(body).not.toContain("sk-policy-secret-key");
    expect(body).not.toContain("policyTruth");
    expect(body).not.toContain("realStageProgress");
    expect(body).not.toContain("corruptionAccruedTaels");
  });

  it("合法性崩坏时直诏被规则阻断（POLICY_LEGALITY_BLOCKED），revision 不变", async () => {
    // 将合法性压到 15 以下（数据驱动规则 rule-legitimacy-collapse-block）
    let current = await revision();
    const state = J(await app.inject({ method: "GET", url: "/api/saves/s1/state" })).data;
    const drop = 14 - (state.country.legitimacy as number);
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/commands",
      payload: {
        commandId: "cmd_drop_legitimacy",
        commandType: "country.adjust-resource",
        baseRevision: current,
        payload: { resource: "legitimacy", delta: drop, reason: "测试降合法性" },
      },
    });
    current = await revision();
    await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies",
      payload: {
        policyId: "psec-blocked",
        templateId: "policy-chaihui-shengci",
        expectedRevision: current,
      },
    });
    current = await revision();
    const before = current;
    const approve = await app.inject({
      method: "POST",
      url: "/api/saves/s1/policies/psec-blocked/decision",
      payload: { decision: "approve", expectedRevision: current },
    });
    expect(approve.statusCode).toBe(422);
    expect(J(approve).error?.code).toBe("POLICY_LEGALITY_BLOCKED");
    expect(await revision()).toBe(before);
  });
});

describe("生产配置下政策 Debug API 关闭", () => {
  it("production 下 truth/rule-trace/rules 全部 404", async () => {
    const prodApp = await buildApp({
      config: parseRuntimeConfig({
        NODE_ENV: "production",
        LLM_PROVIDER: "mock",
        SAVE_DATABASE_PATH: ":memory:",
      }),
      provider: createCharacterMockProvider({}, NAMES),
      logger: false,
    });
    for (const url of [
      "/api/debug/saves/x/policies/y/truth",
      "/api/debug/saves/x/policies/y/rule-trace",
      "/api/debug/saves/x/rules",
    ]) {
      const response = await prodApp.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
    await prodApp.close();
  });
});
