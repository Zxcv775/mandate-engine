import { estimateTokens } from "@mandate/llm-adapters";
import type { PromptBudgetReport, PromptBudgetSegmentReport } from "./types";

/** 预算硬超限：调用方应映射为 PROMPT_BUDGET_EXCEEDED */
export class PromptBudgetExceededError extends Error {
  constructor(
    readonly totalCharacters: number,
    readonly maxCharacters: number,
    readonly totalEstimatedTokens: number,
    readonly maxEstimatedTokens: number,
  ) {
    super(
      `Prompt 超出预算：${totalCharacters}/${maxCharacters} 字符，` +
        `约 ${totalEstimatedTokens}/${maxEstimatedTokens} token`,
    );
    this.name = "PromptBudgetExceededError";
  }
}

export function measureSegment(segment: string, content: string): PromptBudgetSegmentReport {
  return {
    segment,
    characters: content.length,
    estimatedTokens: estimateTokens(content),
  };
}

export function buildBudgetReport(
  segments: readonly PromptBudgetSegmentReport[],
  trimmed: readonly string[],
  limits: { maxPromptCharacters: number; maxEstimatedTokens: number },
): PromptBudgetReport {
  const totalCharacters = segments.reduce((sum, item) => sum + item.characters, 0);
  const totalEstimatedTokens = segments.reduce((sum, item) => sum + item.estimatedTokens, 0);
  return {
    totalCharacters,
    totalEstimatedTokens,
    segments,
    trimmed,
    withinBudget:
      totalCharacters <= limits.maxPromptCharacters &&
      totalEstimatedTokens <= limits.maxEstimatedTokens,
  };
}
