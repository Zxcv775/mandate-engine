import {
  RuntimeConfigResponseSchema,
  ScenarioListResponseSchema,
  ScenarioResponseSchema,
  toLlmVisibleGameState,
  type GameState,
} from "@mandate/domain";
import { MockLLMProvider } from "@mandate/llm-adapters";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

describe("Phase 1 集成闭环", () => {
  it("配置 → Mock → 场景加载 → 内存 Fastify → runtime/scenarios", async () => {
    const config = parseRuntimeConfig({ NODE_ENV: "test" });
    const app = await buildApp({
      config,
      provider: new MockLLMProvider({ model: config.llm.model }),
      logger: false,
    });

    const runtime = RuntimeConfigResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/config/runtime" })).json(),
    );
    const scenarios = ScenarioListResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/scenarios" })).json(),
    );
    const scenario = ScenarioResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/scenarios/chongzhen-early" })).json(),
    );
    await app.close();

    expect(runtime.data.provider).toMatchObject({ name: "mock", isMock: true });
    expect(scenarios.data.map((item) => item.id)).toContain("chongzhen-early");
    expect(scenario.data).toMatchObject({ id: "chongzhen-early", schemaValidated: true });
  });

  it("日志脱敏覆盖 Authorization 与显式 apiKey 字段", async () => {
    const marker = "phase1-log-secret-marker";
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const app = await buildApp({
      config: parseRuntimeConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "openai-compatible",
        LLM_BASE_URL: "http://127.0.0.1:9/v1",
        LLM_MODEL: "local-placeholder",
        LLM_API_KEY: marker,
      }),
      logger: { level: "info", stream },
    });
    app.get("/api/test/log-redaction", (request) => {
      request.log.info({ headers: request.headers, apiKey: marker }, "脱敏探针");
      return { ok: true };
    });

    await app.inject({
      method: "GET",
      url: "/api/test/log-redaction",
      headers: { authorization: `Bearer ${marker}` },
    });
    await app.close();

    expect(logs).toContain("[Redacted]");
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain(`Bearer ${marker}`);
  });
});

describe("LLM 可见状态边界", () => {
  it("纯函数复制状态并剥离 hidden，不修改原对象", () => {
    const state: GameState = {
      sessionId: "session-1",
      currentGameDate: "1627-10-02",
      turn: 0,
      country: {
        id: "country-1",
        name: "明",
        dynastyId: "ming",
        rulerCharacterId: "ruler",
        treasury: 0,
        grainReserves: 0,
        stability: 50,
        prestige: 50,
        corruptionIndex: 50,
        adminEfficiency: 50,
      },
      regions: [],
      characters: [],
      officeHolders: [],
      factions: [],
      relationships: [],
      policies: [],
      armies: [],
      wars: [],
      firedEventIds: [],
      hidden: {
        trueLoyalty: { official: 1 },
        conspiracyFlags: { secret: 9 },
        leakAccumulators: {},
      },
    };

    const visible = toLlmVisibleGameState(state);

    expect(visible).not.toHaveProperty("hidden");
    expect(JSON.stringify(visible)).not.toContain("conspiracyFlags");
    expect(state.hidden.conspiracyFlags.secret).toBe(9);
    expect(visible).not.toBe(state);
  });
});
