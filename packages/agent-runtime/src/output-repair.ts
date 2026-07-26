import { CharacterAgentModelOutputSchema, type CharacterAgentModelOutput } from "@mandate/domain";
import { extractJson, type LLMMessage, type LLMResult } from "@mandate/llm-adapters";
import { loadPrompt, renderPrompt, type PromptId } from "@mandate/prompt-system";
import type { z } from "zod";
import { CharacterAgentError } from "./errors";

/**
 * 结构化输出修复（ADR-014）。
 * 与 BaseLLMProvider 的"同消息盲重试"不同：修复请求是受控的专用 Prompt，
 * 只包含 ①原始输出 ②安全化的校验错误摘要 ③输出格式契约——不重发完整人物上下文。
 * 修复次数受限（默认 1），超限返回稳定错误，绝不猜测补齐字段。
 * Phase 4：Schema 与契约资产可参数化（会议输出复用同一条修复链）。
 */

export interface StructuredGenerationDependencies {
  generate(messages: LLMMessage[]): Promise<LLMResult>;
}

export interface StructuredGenerationOptions<T> {
  maxRepairAttempts: number;
  /** 目标 Schema；缺省为 Phase 3 单人物输出契约 */
  schema?: z.ZodType<T>;
  /** 修复时随附的输出契约资产；缺省为 character-response */
  contractPromptIds?: readonly PromptId[];
}

export interface StructuredGenerationOutcome<T> {
  output: T;
  repaired: boolean;
  repairAttempts: number;
  provider: string;
  model: string;
}

interface ParseAttempt<T> {
  output?: T;
  errorSummary?: string;
}

function tryParse<T>(text: string, schema: z.ZodType<T>): ParseAttempt<T> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJson(text));
  } catch (error) {
    return {
      errorSummary: `JSON 解析失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  }
  const result = schema.safeParse(candidate);
  if (result.success) return { output: result.data };
  const summary = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
    .join("；");
  return { errorSummary: `Schema 校验失败：${summary}` };
}

export async function generateCharacterOutputWithRepair<T = CharacterAgentModelOutput>(
  dependencies: StructuredGenerationDependencies,
  messages: LLMMessage[],
  options: StructuredGenerationOptions<T>,
): Promise<StructuredGenerationOutcome<T>> {
  const schema = (options.schema ?? CharacterAgentModelOutputSchema) as unknown as z.ZodType<T>;
  const contractPromptIds = options.contractPromptIds ?? ["output.character-response"];

  const first = await dependencies.generate(messages);
  const firstParse = tryParse(first.text, schema);
  if (firstParse.output !== undefined) {
    return {
      output: firstParse.output,
      repaired: false,
      repairAttempts: 0,
      provider: first.provider,
      model: first.model,
    };
  }

  if (options.maxRepairAttempts <= 0) {
    throw new CharacterAgentError(
      "CHARACTER_OUTPUT_INVALID",
      "人物结构化输出未通过校验，且未启用修复",
      firstParse.errorSummary,
    );
  }

  const [repairAsset, ...contractAssets] = await Promise.all([
    loadPrompt("output.repair-structured-output"),
    ...contractPromptIds.map((id) => loadPrompt(id)),
  ]);
  const contractText = contractAssets.map((asset) => asset.template).join("\n\n");

  let lastText = first.text;
  let lastError = firstParse.errorSummary ?? "未知校验错误";
  for (let attempt = 1; attempt <= options.maxRepairAttempts; attempt++) {
    const repairMessages: LLMMessage[] = [
      { role: "system", content: contractText },
      {
        role: "user",
        content: renderPrompt(repairAsset.template, {
          invalidOutput: lastText.slice(0, 8_000),
          validationErrors: lastError,
        }),
      },
    ];
    const repaired = await dependencies.generate(repairMessages);
    const parsed = tryParse(repaired.text, schema);
    if (parsed.output !== undefined) {
      return {
        output: parsed.output,
        repaired: true,
        repairAttempts: attempt,
        provider: repaired.provider,
        model: repaired.model,
      };
    }
    lastText = repaired.text;
    lastError = parsed.errorSummary ?? "未知校验错误";
  }

  throw new CharacterAgentError(
    "LLM_OUTPUT_REPAIR_FAILED",
    `结构化输出修复 ${options.maxRepairAttempts} 次后仍未通过校验`,
    lastError,
  );
}
