import { ApiErrorResponseSchema, type ApiErrorCode } from "@mandate/domain";
import type { ZodType } from "zod";

export type ApiClientErrorKind = "offline" | "api_error" | "data_error" | "timeout" | "cancelled";

interface ApiClientErrorOptions {
  code?: ApiErrorCode;
  requestId?: string;
  cause?: unknown;
}

export class ApiClientError extends Error {
  readonly code?: ApiErrorCode;
  readonly requestId?: string;

  constructor(
    readonly kind: ApiClientErrorKind,
    message: string,
    options: ApiClientErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApiClientError";
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
}

export interface ApiClient {
  get<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
  delete<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T>;
}

function requestUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${normalizedPath}` : normalizedPath;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const timeoutMs = options.timeoutMs ?? 8_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    requestBody: unknown,
    schema: ZodType<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const startedAt = performance.now();
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(requestUrl(baseUrl, path), {
        method,
        headers:
          requestBody === undefined
            ? { Accept: "application/json" }
            : { Accept: "application/json", "Content-Type": "application/json" },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok && response.status >= 500 && !contentType.includes("json")) {
        throw new ApiClientError("offline", "后端服务离线或开发代理无法连接");
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new ApiClientError("data_error", "服务器返回了无效 JSON", { cause: error });
      }

      if (!response.ok) {
        const parsedError = ApiErrorResponseSchema.safeParse(responseBody);
        if (!parsedError.success) {
          throw new ApiClientError("data_error", "服务器错误响应格式无效", {
            cause: parsedError.error,
          });
        }
        throw new ApiClientError("api_error", parsedError.data.error.message, {
          code: parsedError.data.error.code,
          requestId: parsedError.data.meta.requestId,
        });
      }

      const parsed = schema.safeParse(responseBody);
      if (!parsed.success) {
        throw new ApiClientError("data_error", "服务器响应不符合 API Schema", {
          cause: parsed.error,
        });
      }

      if (import.meta.env?.DEV && import.meta.env.MODE !== "test") {
        console.debug("API 请求完成", {
          path,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (timedOut) {
        throw new ApiClientError("timeout", "API 请求超时", { cause: error });
      }
      if (callerSignal?.aborted) {
        throw new ApiClientError("cancelled", "API 请求已取消", { cause: error });
      }
      throw new ApiClientError("offline", "后端服务离线或网络不可用", { cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    get<T>(path: string, schema: ZodType<T>, signal?: AbortSignal) {
      return request("GET", path, undefined, schema, signal);
    },
    post<T>(path: string, body: unknown, schema: ZodType<T>, signal?: AbortSignal) {
      return request("POST", path, body, schema, signal);
    },
    delete<T>(path: string, schema: ZodType<T>, signal?: AbortSignal) {
      return request("DELETE", path, undefined, schema, signal);
    },
  };
}

export const apiClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
});
