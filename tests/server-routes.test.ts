import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorResponseSchema,
  HealthResponseSchema,
  RuntimeConfigResponseSchema,
  ScenarioListResponseSchema,
  ScenarioResponseSchema,
  VersionResponseSchema,
} from "@mandate/domain";
import { ENGINE_INFO } from "@mandate/shared";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

const config = parseRuntimeConfig({ NODE_ENV: "test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 1 基础路由", () => {
  it("GET /api/health 返回统一 Envelope 且不调用 LLM", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildApp({ config, logger: false });

    const response = await app.inject({ method: "GET", url: "/api/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: "ok",
        service: "mandate-server",
      },
      meta: { requestId: expect.any(String) },
    });
    expect(new Date(body.data.timestamp).toISOString()).toBe(body.data.timestamp);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GET /api/version 使用统一版本常量", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/version" });
    await app.close();

    expect(VersionResponseSchema.parse(response.json())).toMatchObject({
      ok: true,
      data: ENGINE_INFO,
      meta: { requestId: expect.any(String) },
    });
  });

  it("GET /api/config/runtime 只公开安全摘要", async () => {
    const marker = "phase1-api-key-marker";
    const app = await buildApp({
      config: parseRuntimeConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "openai-compatible",
        LLM_BASE_URL: "https://example.invalid/v1",
        LLM_MODEL: "remote-model",
        LLM_API_KEY: marker,
      }),
      logger: false,
    });
    const response = await app.inject({ method: "GET", url: "/api/config/runtime" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = RuntimeConfigResponseSchema.parse(response.json());
    expect(body.data.provider).toEqual({
      name: "openai-compatible",
      model: "remote-model",
      hasApiKey: true,
      baseUrlConfigured: true,
      isMock: false,
    });
    expect(response.body).not.toContain(marker);
    expect(response.body).not.toContain("apiKey");
  });
});

describe("场景元数据路由", () => {
  it("GET /api/scenarios 返回通过深度校验的摘要列表", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/scenarios" });
    await app.close();

    const body = ScenarioListResponseSchema.parse(response.json());
    expect(response.statusCode).toBe(200);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "chongzhen-early",
          name: "崇祯初政",
          dynastyId: "ming",
          dynastyName: "明",
          startGameDate: "1627-10-02",
          status: "prototype",
          historicalDataCompleteness: "partial",
          schemaValidated: true,
        }),
      ]),
    );
  });

  it("GET /api/scenarios/:id 返回单个摘要而非完整 Bundle", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/scenarios/chongzhen-early",
    });
    await app.close();

    const body = ScenarioResponseSchema.parse(response.json());
    expect(response.statusCode).toBe(200);
    expect(body.data.id).toBe("chongzhen-early");
    expect(body.data).not.toHaveProperty("characters");
    expect(body.data).not.toHaveProperty("historicalSources");
  });

  it("未知场景返回 SCENARIO_NOT_FOUND", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/scenarios/missing" });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SCENARIO_NOT_FOUND",
    );
  });

  it("空白场景 ID 返回 VALIDATION_ERROR", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/scenarios/%20" });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("统一错误格式", () => {
  it("404 返回 ROUTE_NOT_FOUND 与 requestId", async () => {
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/missing" });
    await app.close();

    expect(response.statusCode).toBe(404);
    expect(ApiErrorResponseSchema.parse(response.json())).toEqual({
      ok: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "请求的 API 路由不存在",
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("Zod 参数错误返回稳定 details", async () => {
    const app = await buildApp({ config, logger: false });
    app.get("/api/test/validation", () => {
      return z.object({ scenarioId: z.string().min(1) }).parse({ scenarioId: "" });
    });

    const response = await app.inject({ method: "GET", url: "/api/test/validation" });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "请求参数无效",
        details: [
          {
            path: "scenarioId",
            message: expect.any(String),
            type: expect.any(String),
          },
        ],
      },
      meta: { requestId: expect.any(String) },
    });
  });

  it("未知异常不向响应暴露消息或堆栈", async () => {
    const app = await buildApp({ config, logger: false });
    app.get("/api/test/boom", () => {
      throw new Error("internal-secret-marker");
    });

    const response = await app.inject({ method: "GET", url: "/api/test/boom" });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务器内部错误" },
      meta: { requestId: expect.any(String) },
    });
    expect(response.body).not.toContain("internal-secret-marker");
    expect(response.body).not.toContain("stack");
  });
});
