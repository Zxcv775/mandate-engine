import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMStructuredOptions,
} from "@mandate/llm-adapters";
import type { RuntimeConfig } from "../config/index";

export interface LlmServiceLogger {
  info(value: Record<string, unknown>): void;
  error(value: Record<string, unknown>): void;
}

export interface LlmService {
  generateText(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResult>;
  generateStructured<T>(messages: LLMMessage[], options: LLMStructuredOptions<T>): Promise<T>;
}

export function createLlmService(
  provider: LLMProvider,
  config: RuntimeConfig["llm"],
  logger: LlmServiceLogger,
): LlmService {
  async function execute<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      logger.info({
        event: "llm_call",
        provider: provider.name,
        model: config.model,
        durationMs: Math.round(performance.now() - startedAt),
        success: true,
      });
      return result;
    } catch (error) {
      logger.error({
        event: "llm_call",
        provider: provider.name,
        model: config.model,
        durationMs: Math.round(performance.now() - startedAt),
        success: false,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  }

  return {
    generateText(messages, options = {}) {
      return execute(() =>
        provider.generate(messages, {
          ...options,
          model: options.model ?? config.model,
          timeoutMs: options.timeoutMs ?? config.timeoutMs,
        }),
      );
    },
    generateStructured(messages, options) {
      return execute(() =>
        provider.generateStructured(messages, {
          ...options,
          model: options.model ?? config.model,
          timeoutMs: options.timeoutMs ?? config.timeoutMs,
          maxRetries: options.maxRetries ?? config.maxRetries,
        }),
      );
    },
  };
}
