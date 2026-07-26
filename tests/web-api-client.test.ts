import { HealthResponseSchema } from "@mandate/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient } from "../apps/web/src/api/client";

const healthEnvelope = {
  ok: true,
  data: {
    status: "ok",
    service: "mandate-server",
    timestamp: "2026-07-26T00:00:00.000Z",
  },
  meta: { requestId: "req-1" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Web API Client", () => {
  it("解析成功 Envelope 并执行响应 Schema", async () => {
    const fetchImpl = vi.fn(async () => Response.json(healthEnvelope));
    const client = createApiClient({ baseUrl: "http://localhost:3000", fetchImpl });

    await expect(client.get("/api/health", HealthResponseSchema)).resolves.toEqual(healthEnvelope);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/health",
      expect.objectContaining({ method: "GET", headers: { Accept: "application/json" } }),
    );
  });

  it("将非 2xx Error Envelope 映射为 api_error", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          error: { code: "SCENARIO_NOT_FOUND", message: "场景不存在" },
          meta: { requestId: "req-2" },
        },
        { status: 404 },
      ),
    );
    const client = createApiClient({ fetchImpl });

    await expect(client.get("/api/scenarios/missing", HealthResponseSchema)).rejects.toMatchObject({
      kind: "api_error",
      code: "SCENARIO_NOT_FOUND",
      requestId: "req-2",
    });
  });

  it.each([
    ["非法 JSON", new Response("not-json")],
    ["Schema 不匹配", Response.json({ ok: true, data: {} })],
  ])("将%s映射为 data_error", async (_label, response) => {
    const client = createApiClient({ fetchImpl: vi.fn(async () => response) });

    await expect(client.get("/api/health", HealthResponseSchema)).rejects.toMatchObject({
      kind: "data_error",
    });
  });

  it("将网络失败映射为 offline", async () => {
    const client = createApiClient({
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    await expect(client.get("/api/health", HealthResponseSchema)).rejects.toMatchObject({
      kind: "offline",
    });
  });

  it("将开发代理的非 JSON 5xx 连接失败映射为 offline", async () => {
    const client = createApiClient({
      fetchImpl: vi.fn(
        async () =>
          new Response("", {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });

    await expect(client.get("/api/health", HealthResponseSchema)).rejects.toMatchObject({
      kind: "offline",
    });
  });

  it("区分超时与调用方取消", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const client = createApiClient({ timeoutMs: 25, fetchImpl });
    const timeoutRequest = client.get("/api/health", HealthResponseSchema);
    const timeoutAssertion = expect(timeoutRequest).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;

    const controller = new AbortController();
    const cancelledRequest = client.get("/api/health", HealthResponseSchema, controller.signal);
    const cancelledAssertion = expect(cancelledRequest).rejects.toMatchObject({
      kind: "cancelled",
    });
    controller.abort();
    await cancelledAssertion;
  });

  it("暴露稳定的客户端错误类型", () => {
    expect(new ApiClientError("offline", "后端离线")).toBeInstanceOf(Error);
  });
});
