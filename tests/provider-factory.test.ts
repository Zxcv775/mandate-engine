import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLLMProvider, OpenAiCompatibleProvider, type LLMMessage } from "@mandate/llm-adapters";
import type { RuntimeConfig } from "../apps/server/src/config/index";
import {
  ProviderInitializationError,
  createLlmProvider,
} from "../apps/server/src/providers/provider-factory";
import { createLlmService } from "../apps/server/src/services/llm-service";

const messages: LLMMessage[] = [{ role: "user", content: "测试" }];

function mockConfig(overrides: Partial<RuntimeConfig["llm"]> = {}): RuntimeConfig["llm"] {
  return {
    provider: "mock",
    model: "phase1-mock",
    timeoutMs: 1_234,
    maxRetries: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createLlmProvider", () => {
  it("Mock 配置返回配置过模型名的 MockLLMProvider", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createLlmProvider(mockConfig());
    const result = await provider.generate(messages);

    expect(provider).toBeInstanceOf(MockLLMProvider);
    expect(result.model).toBe("phase1-mock");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("OpenAI-compatible 配置传入 URL、模型和 Authorization", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createLlmProvider(
      mockConfig({
        provider: "openai-compatible",
        baseUrl: "https://example.invalid/v1/",
        apiKey: "secret-marker",
        model: "remote-model",
        maxRetries: 0,
      }),
    );
    const result = await provider.generate(messages);

    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(result.model).toBe("remote-model");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.invalid/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret-marker" });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "remote-model", messages });
  });

  it("未知 Provider 给出明确初始化错误", () => {
    expect(() => createLlmProvider({ ...mockConfig(), provider: "unknown" } as never)).toThrow(
      /unknown/,
    );
  });

  it("无效 OpenAI Base URL 给出清晰构造错误", () => {
    expect(() =>
      createLlmProvider(
        mockConfig({
          provider: "openai-compatible",
          baseUrl: "not-a-url",
          model: "remote-model",
        }),
      ),
    ).toThrow(ProviderInitializationError);
  });
});

describe("LlmService", () => {
  it("允许测试替换 Provider，并为结构化输出注入默认重试次数", async () => {
    const provider = new MockLLMProvider({
      responses: ["bad", '{"name":"通过"}'],
      model: "injected-model",
    });
    const logs: unknown[] = [];
    const service = createLlmService(provider, mockConfig({ apiKey: "secret-marker" }), {
      info: (value) => logs.push(value),
      error: (value) => logs.push(value),
    });

    const result = await service.generateStructured(messages, {
      schema: z.object({ name: z.string() }),
    });

    expect(result).toEqual({ name: "通过" });
    expect(provider.calls).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("secret-marker");
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "llm_call",
          provider: "mock",
          model: "phase1-mock",
          success: true,
        }),
      ]),
    );
  });
});
