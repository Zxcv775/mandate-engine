import type {
  HealthData,
  PublicRuntimeConfig,
  ScenarioSummary,
  VersionData,
} from "@mandate/domain";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../apps/web/src/api/client";
import {
  createRuntimeStore,
  type RuntimeApi,
} from "../apps/web/src/store/runtime-store";

const health: HealthData = {
  status: "ok",
  service: "mandate-server",
  timestamp: "2026-07-26T00:00:00.000Z",
};
const version: VersionData = { name: "mandate-engine", version: "0.1.0", phase: 1 };
const runtime: PublicRuntimeConfig = {
  environment: "test",
  provider: {
    name: "mock",
    model: "mock-model",
    hasApiKey: false,
    baseUrlConfigured: false,
    isMock: true,
  },
  scenario: { defaultScenarioId: "chongzhen-early" },
};
const scenario: ScenarioSummary = {
  id: "chongzhen-early",
  name: "崇祯初政",
  dynastyId: "ming",
  dynastyName: "明",
  startGameDate: "1627-10-02",
  status: "prototype",
  historicalDataCompleteness: "placeholder",
  schemaValidated: true,
};

function createSuccessfulApi(overrides: Partial<RuntimeApi> = {}): RuntimeApi {
  return {
    getHealth: vi.fn(async () => health),
    getVersion: vi.fn(async () => version),
    getRuntimeConfig: vi.fn(async () => runtime),
    getScenario: vi.fn(async () => scenario),
    ...overrides,
  };
}

describe("Runtime Dashboard Store", () => {
  it("完成 health/version/runtime/scenario 最小闭环", async () => {
    const api = createSuccessfulApi();
    const store = createRuntimeStore(api);

    await store.getState().refresh();
    const state = store.getState();

    expect(state.health).toMatchObject({ status: "success", data: health });
    expect(state.health.responseTimeMs).toEqual(expect.any(Number));
    expect(state.version).toEqual({ status: "success", data: version });
    expect(state.runtime).toEqual({ status: "success", data: runtime });
    expect(state.scenario).toEqual({ status: "success", data: scenario });
    expect(state.lastRefreshedAt).toEqual(expect.any(String));
    expect(api.getScenario).toHaveBeenCalledWith("chongzhen-early", expect.any(AbortSignal));
  });

  it("场景 API 失败时保留其他卡片的成功状态", async () => {
    const store = createRuntimeStore(
      createSuccessfulApi({
        getScenario: vi.fn(async () => {
          throw new ApiClientError("api_error", "场景加载失败", {
            code: "DATA_SCHEMA_INVALID",
          });
        }),
      }),
    );

    await store.getState().refresh();
    const state = store.getState();
    expect(state.health.status).toBe("success");
    expect(state.version.status).toBe("success");
    expect(state.runtime.status).toBe("success");
    expect(state.scenario).toMatchObject({ status: "api_error", error: "场景加载失败" });
  });

  it("网络失败映射为 offline，而非笼统错误", async () => {
    const offline = vi.fn(async () => {
      throw new ApiClientError("offline", "后端服务离线或网络不可用");
    });
    const store = createRuntimeStore(
      createSuccessfulApi({
        getHealth: offline,
        getVersion: offline,
        getRuntimeConfig: offline,
      }),
    );

    await store.getState().refresh();
    expect(store.getState().health.status).toBe("offline");
    expect(store.getState().version.status).toBe("offline");
    expect(store.getState().runtime.status).toBe("offline");
    expect(store.getState().scenario.status).toBe("offline");
  });

  it("再次刷新会取消尚未完成的旧请求", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const getHealth = vi.fn((signal: AbortSignal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(health);
      firstSignal = signal;
      return new Promise<HealthData>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new ApiClientError("cancelled", "API 请求已取消")),
          { once: true },
        );
      });
    });
    const store = createRuntimeStore(createSuccessfulApi({ getHealth }));

    const firstRefresh = store.getState().refresh();
    const secondRefresh = store.getState().refresh();
    await Promise.all([firstRefresh, secondRefresh]);

    expect(firstSignal?.aborted).toBe(true);
    expect(store.getState().health.status).toBe("success");
  });
});
