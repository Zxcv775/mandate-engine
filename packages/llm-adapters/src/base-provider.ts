import { StructuredOutputError } from "./errors";
import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMStructuredOptions,
} from "./types";

/** 从 LLM 文本中提取 JSON：剥离 ```json 围栏并截取首尾花括号区间 */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError("LLM 输出中未找到 JSON 片段");
  }
  return candidate.slice(start, end + 1);
}

/**
 * 抽象基类：统一实现 generateStructured（JSON 提取 + Zod 校验 + 重试）。
 * 子类只需实现 generate。
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;

  abstract generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions,
  ): Promise<LLMResult>;

  async generateStructured<T>(
    messages: LLMMessage[],
    options: LLMStructuredOptions<T>,
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.generate(messages, options);
      try {
        const parsed: unknown = JSON.parse(extractJson(result.text));
        return options.schema.parse(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw new StructuredOutputError(
      `结构化输出在 ${maxRetries + 1} 次尝试后仍未通过 Schema 校验`,
      lastError,
    );
  }
}
