import { BaseLLMProvider } from "./base-provider";
import { estimateUsage } from "./context";
import { LLMProviderError } from "./errors";
import type { LLMGenerateOptions, LLMMessage, LLMResult, LLMUsage } from "./types";

export interface OpenAiCompatibleConfig {
  /** 例如 https://api.example.com/v1 或 http://127.0.0.1:1234/v1 */
  baseUrl: string;
  /** 本地模型通常不需要；云端经环境变量注入 */
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * OpenAI 兼容端点适配器（/chat/completions）。
 * 基于 Node 内置 fetch，零 SDK 依赖；可对接云端与 LM Studio / Ollama 等本地模型。
 * 流式生成（SSE）在 Phase 4 实现（FR-LLM-101）。
 */
export class OpenAiCompatibleProvider extends BaseLLMProvider {
  readonly name = "openai-compatible";

  private readonly config: Required<Omit<OpenAiCompatibleConfig, "apiKey">> &
    Pick<OpenAiCompatibleConfig, "apiKey">;

  constructor(config: OpenAiCompatibleConfig) {
    super();
    const baseUrl = new URL(config.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new TypeError("OpenAI-compatible Base URL 必须使用 http 或 https 协议");
    }
    if (config.model.trim() === "") {
      throw new TypeError("OpenAI-compatible 模型名称不能为空");
    }
    this.config = {
      timeoutMs: 30_000,
      maxRetries: 2,
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    };
  }

  async generate(messages: LLMMessage[], options: LLMGenerateOptions = {}): Promise<LLMResult> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const maxRetries = this.config.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.requestOnce(messages, options, timeoutMs);
      } catch (error) {
        lastError = error;
        if (error instanceof LLMProviderError && !error.message.includes("重试")) {
          // 4xx 等不可重试错误直接抛出
          throw error;
        }
        if (attempt < maxRetries) {
          await sleep(2 ** attempt * 500);
        }
      }
    }
    throw new LLMProviderError(this.name, `请求在 ${maxRetries + 1} 次尝试后失败`, lastError);
  }

  private async requestOnce(
    messages: LLMMessage[],
    options: LLMGenerateOptions,
    timeoutMs: number,
  ): Promise<LLMResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model ?? this.config.model,
          messages,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 网络错误/超时：可重试
      throw new LLMProviderError(this.name, "网络请求失败（可重试）", error);
    }

    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      throw new LLMProviderError(
        this.name,
        `HTTP ${response.status}${retryable ? "（可重试）" : ""}`,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    const usage: LLMUsage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : estimateUsage(messages, text);

    return {
      text,
      usage,
      model: options.model ?? this.config.model,
      provider: this.name,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
