import {
  MockLLMProvider,
  OpenAiCompatibleProvider,
  type LLMProvider,
  type LLMMessage,
} from "@mandate/llm-adapters";
import { buildMockCharacterOutput } from "@mandate/agent-runtime";
import type { CharacterConversationMode } from "@mandate/domain";
import type { RuntimeConfig } from "../config/index";

/**
 * 默认 Mock 的兜底应答：识别 Character Agent Prompt 时返回合法结构化响应，
 * 保证离线环境可以完整走通人物闭环（含 Character Lab 联调）；其余请求返回空串。
 */
function defaultMockHandler(messages: LLMMessage[]): string {
  const text = messages.map((message) => message.content).join("\n");
  if (!text.includes("天命人物扮演系统")) return "";
  const modeByMarker: ReadonlyArray<[string, CharacterConversationMode]> = [
    ["当前场合：单独召见", "private-audience"],
    ["当前场合：大朝会", "court-assembly"],
    ["当前场合：御前会议", "imperial-council"],
    ["当前场合：秘密议事", "secret-council"],
    ["当前场合：奏疏应对", "memorial-response"],
  ];
  const mode = modeByMarker.find(([marker]) => text.includes(marker))?.[1] ?? "general";
  return JSON.stringify(buildMockCharacterOutput("support", { mode }));
}

export class ProviderInitializationError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    cause?: unknown,
  ) {
    super(`LLM Provider "${provider}" 初始化失败：${message}`, { cause });
    this.name = "ProviderInitializationError";
  }
}

export function createLlmProvider(config: RuntimeConfig["llm"]): LLMProvider {
  try {
    switch (config.provider) {
      case "mock":
        return new MockLLMProvider({ model: config.model, handler: defaultMockHandler });
      case "openai-compatible":
        if (!config.baseUrl) {
          throw new TypeError("缺少 Base URL");
        }
        return new OpenAiCompatibleProvider({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
        });
      default:
        throw new TypeError(`未知 Provider：${String(config.provider)}`);
    }
  } catch (error) {
    if (error instanceof ProviderInitializationError) throw error;
    throw new ProviderInitializationError(
      String(config.provider),
      error instanceof Error ? error.message : "未知错误",
      error,
    );
  }
}
