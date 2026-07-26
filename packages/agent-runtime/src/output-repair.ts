import {
  CharacterAgentModelOutputSchema,
  type CharacterAgentModelOutput,
} from "@mandate/domain";
import { extractJson, type LLMMessage, type LLMResult } from "@mandate/llm-adapters";
import { loadPrompt, renderPrompt } from "@mandate/prompt-system";
import { CharacterAgentError } from "./errors";

/**
 * 结构化输出修复（ADR-014）。
 * 与 BaseLLMProvider 的"同消息盲重试"不同：修复请求是受控的专用 Prompt，
 * 只包含 ①原始输出 ②安全化的校验错误摘要 ③输出格式契约——不重发完整人物上下文。
 * 修复次数受限（默认 1），超限返回稳定错误，绝不猜测补齐字段。
 */

export interface StructuredGenerationDependencies {
  generate(messages: LLMMessage[]): Promise<LLMResult>;
}

export interface StructuredGenerationOutcome {
  output: CharacterAgentModelOutput;
  repaired: boolean;
  repairAttempts: number;
  provider: string;
  model: string;
}

interface ParseAttempt {
  output?: CharacterAgentModelOutput;
  errorSummary?: string;
}

function tryParse(text: string): ParseAttempt {
  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJson(text));
  } catch (error) {
    return { errorSummary: `JSON 解析失败：${error instanceof Error ? error.message : "未知错误"}` };
  }
  const result = CharacterAgentModelOutputSchema.safeParse(candidate);
  if (result.success) return { output: result.data };
  const summary = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
    .join("；");
  return { errorSummary: `Schema 校验失败：${summary}` };
}

export async function generateCharacterOutputWithRepair(
  dependencies: StructuredGenerationDependencies,
  messages: LLMMessage[],
  options: { maxRepairAttempts: number },
): Promise<StructuredGenerationOutcome> {
  const first = await dependencies.generate(messages);
  const firstParse = tryParse(first.text);
  if (firstParse.output) {
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

  const [repairAsset, contractAsset] = await Promise.all([
    loadPrompt("output.repair-structured-output"),
    loadPrompt("output.character-response"),
  ]);

  let lastText = first.text;
  let lastError = firstParse.errorSummary ?? "未知校验错误";
  for (let attempt = 1; attempt <= options.maxRepairAttempts; attempt++) {
    const repairMessages: LLMMessage[] = [
      { role: "system", content: contractAsset.template },
      {
        role: "user",
        content: renderPrompt(repairAsset.template, {
          invalidOutput: lastText.slice(0, 8_000),
          validationErrors: lastError,
        }),
      },
    ];
    const repaired = await dependencies.generate(repairMessages);
    const parsed = tryParse(repaired.text);
    if (parsed.output) {
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
