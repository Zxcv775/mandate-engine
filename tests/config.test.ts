import { describe, expect, it } from "vitest";
import {
  RuntimeConfigError,
  parseRuntimeConfig,
  toPublicRuntimeConfig,
} from "../apps/server/src/config/index";

describe("RuntimeConfig", () => {
  it("默认装配离线 Mock 配置", () => {
    const config = parseRuntimeConfig({});

    expect(config).toEqual({
      nodeEnv: "development",
      server: {
        host: "127.0.0.1",
        port: 3000,
        logLevel: "info",
      },
      llm: {
        provider: "mock",
        model: "mock-model",
        timeoutMs: 30_000,
        maxRetries: 2,
      },
      scenario: {
        defaultScenarioId: "chongzhen-early",
      },
      storage: {
        databasePath: "./saves/mandate-engine.sqlite",
        checkpointInterval: 50,
      },
      debug: {
        apiEnabled: true,
      },
      character: {
        maxRepairAttempts: 1,
        memoryMaxPerCharacter: 500,
      },
    });
  });

  it("Debug API 生产环境默认关闭、可显式开启", () => {
    expect(parseRuntimeConfig({ NODE_ENV: "production" }).debug.apiEnabled).toBe(false);
    expect(
      parseRuntimeConfig({ NODE_ENV: "production", DEBUG_API_ENABLED: "true" }).debug.apiEnabled,
    ).toBe(true);
    expect(parseRuntimeConfig({ DEBUG_API_ENABLED: "false" }).debug.apiEnabled).toBe(false);
  });

  it.each([
    [{ SERVER_PORT: "0" }, "SERVER_PORT"],
    [{ SERVER_PORT: "65536" }, "SERVER_PORT"],
    [{ LLM_PROVIDER: "unknown" }, "LLM_PROVIDER"],
    [{ LLM_TIMEOUT_MS: "0" }, "LLM_TIMEOUT_MS"],
    [{ LLM_MAX_RETRIES: "-1" }, "LLM_MAX_RETRIES"],
    [{ DEFAULT_SCENARIO_ID: "   " }, "DEFAULT_SCENARIO_ID"],
    [{ SAVE_CHECKPOINT_INTERVAL: "0" }, "SAVE_CHECKPOINT_INTERVAL"],
  ])("拒绝非法配置 %o，并指出字段 %s", (env, field) => {
    expect(() => parseRuntimeConfig(env)).toThrow(RuntimeConfigError);

    try {
      parseRuntimeConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect((error as RuntimeConfigError).issues.some((issue) => issue.path === field)).toBe(
        true,
      );
      expect((error as Error).message).toContain(field);
    }
  });

  it("OpenAI-compatible 缺少 Base URL 时在配置阶段失败", () => {
    expect(() =>
      parseRuntimeConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_MODEL: "test-model",
      }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it("OpenAI-compatible 缺少模型时在配置阶段失败", () => {
    expect(() =>
      parseRuntimeConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      }),
    ).toThrow(/LLM_MODEL/);
  });

  it("OpenAI-compatible 允许无需 API Key 的本地端点", () => {
    const config = parseRuntimeConfig({
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "http://127.0.0.1:1234/v1/",
      LLM_MODEL: "local-model",
      LLM_API_KEY: "",
    });

    expect(config.llm).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      timeoutMs: 30_000,
      maxRetries: 2,
    });
  });

  it("公开配置只返回凭据存在性", () => {
    const marker = "phase1-secret-marker";
    const config = parseRuntimeConfig({
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: "https://example.invalid/v1",
      LLM_MODEL: "test-model",
      LLM_API_KEY: marker,
    });

    const publicConfig = toPublicRuntimeConfig(config);
    const serialized = JSON.stringify(publicConfig);

    expect(publicConfig.provider).toMatchObject({
      name: "openai-compatible",
      model: "test-model",
      hasApiKey: true,
      baseUrlConfigured: true,
      isMock: false,
    });
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("apiKey");
  });
});
