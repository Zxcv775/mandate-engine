import {
  DEFAULT_MEMORY_BUDGET,
  type CharacterConversationMode,
  type CharacterMemory,
  type MemoryBudget,
} from "@mandate/domain";
import { estimateTokens } from "@mandate/llm-adapters";

/**
 * 确定性记忆选择器（ADR-012）。
 * 不用向量检索：主题/人物/重要度/可信度/时近度的规则评分，
 * 同分按 memoryId 字典序，保证同一输入必得同一输出。
 * sealed 与 forgotten 记忆一律不出选择器（Prompt 不该见到它们）。
 */

export interface MemorySelectionInput {
  readonly memories: readonly CharacterMemory[];
  readonly context: {
    readonly mode: CharacterConversationMode;
    readonly topicIds: readonly string[];
    readonly participantIds: readonly string[];
    readonly currentRevision: number;
  };
  readonly budget?: MemoryBudget;
}

export interface ScoredMemory {
  readonly memory: CharacterMemory;
  readonly score: number;
}

export interface MemorySelectionResult {
  readonly selected: readonly CharacterMemory[];
  /** 参与评分但因预算被排除的条数（不含 sealed/forgotten 的硬过滤） */
  readonly excludedCount: number;
  readonly totalCharacters: number;
  readonly estimatedTokens: number;
}

export function scoreMemory(
  memory: CharacterMemory,
  context: MemorySelectionInput["context"],
): number {
  const topicMatches = memory.topicTags.filter((tag) => context.topicIds.includes(tag)).length;
  const topicScore = Math.min(topicMatches * 25, 50);
  const entityMatches = memory.relatedCharacterIds.filter((id) =>
    context.participantIds.includes(id),
  ).length;
  const entityScore = Math.min(entityMatches * 15, 30);
  const importanceScore = memory.importance * 0.3;
  const confidenceScore = memory.confidence * 0.1;
  const age = Math.max(0, context.currentRevision - memory.sourceRevision);
  const recencyScore = Math.max(0, 20 - age * 0.5);
  const typeBoost = memory.type === "commitment" || memory.type === "instruction" ? 10 : 0;
  const outdatedPenalty = memory.status === "outdated" ? 25 : 0;
  const contradictedPenalty = memory.status === "contradicted" ? 40 : 0;
  return (
    topicScore +
    entityScore +
    importanceScore +
    confidenceScore +
    recencyScore +
    typeBoost -
    outdatedPenalty -
    contradictedPenalty
  );
}

export function selectRelevantMemories(input: MemorySelectionInput): MemorySelectionResult {
  const budget = input.budget ?? DEFAULT_MEMORY_BUDGET;
  const eligible = input.memories.filter(
    (memory) => memory.visibility !== "sealed" && memory.status !== "forgotten",
  );

  const ranked: ScoredMemory[] = eligible
    .map((memory) => ({ memory, score: scoreMemory(memory, input.context) }))
    .sort((a, b) => b.score - a.score || a.memory.memoryId.localeCompare(b.memory.memoryId));

  const selected: CharacterMemory[] = [];
  let totalCharacters = 0;
  let estimatedTotalTokens = 0;
  for (const { memory } of ranked) {
    if (selected.length >= budget.maxItems) break;
    const nextCharacters = totalCharacters + memory.content.length;
    const nextTokens = estimatedTotalTokens + estimateTokens(memory.content);
    if (nextCharacters > budget.maxCharacters || nextTokens > budget.maxEstimatedTokens) break;
    selected.push(memory);
    totalCharacters = nextCharacters;
    estimatedTotalTokens = nextTokens;
  }

  return {
    selected,
    excludedCount: ranked.length - selected.length,
    totalCharacters,
    estimatedTokens: estimatedTotalTokens,
  };
}
