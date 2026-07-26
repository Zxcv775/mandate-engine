import type { z } from "zod";

/**
 * LLM 供应商统一接口（ADR-005）。
 * 业务代码只依赖本接口；供应商经环境变量配置装配。
 */

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 超时（毫秒），适配器以 AbortSignal 实现 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResult {
  text: string;
  usage: LLMUsage;
  model: string;
  provider: string;
}

export interface LLMStructuredOptions<T> extends LLMGenerateOptions {
  /** 结构化输出的 Zod Schema；校验失败按 maxRetries 重试 */
  schema: z.ZodType<T>;
  maxRetries?: number;
}

/**
 * 供应商接口。
 * 安全约束：LLM 输出一律视为不可信输入；适配器不得执行 LLM 返回的任何代码。
 */
export interface LLMProvider {
  readonly name: string;
  /** 普通文本生成 */
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResult>;
  /** 结构化 JSON 输出（Schema 校验 + 重试；最终失败抛 StructuredOutputError） */
  generateStructured<T>(
    messages: LLMMessage[],
    options: LLMStructuredOptions<T>,
  ): Promise<T>;
  /** 流式生成（可选；Phase 4 启用，FR-LLM-101） */
  generateStream?(
    messages: LLMMessage[],
    options?: LLMGenerateOptions,
  ): AsyncIterable<string>;
}
