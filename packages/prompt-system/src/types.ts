export type PromptId =
  | "system.base"
  | "system.character-agent-base"
  | "character.identity"
  | "character.personality"
  | "character.political-profile"
  | "character.communication-style"
  | "knowledge.known-world-state"
  | "context.private-audience"
  | "context.court-assembly"
  | "context.imperial-council"
  | "context.secret-council"
  | "context.memorial-response"
  | "context.general"
  | "context.conversation-input"
  | "memory.memory-context"
  | "memory.memory-candidate"
  | "output.character-response"
  | "output.repair-structured-output"
  | "meeting.court-assembly"
  | "meeting.imperial-council"
  | "meeting.secret-council"
  | "parser.policy-draft"
  | "narrator.memorial-summary";

export interface PromptAsset {
  id: PromptId;
  version: "v1";
  template: string;
}

export type PromptVariables = Readonly<Record<string, string | number | boolean>>;

/** Prompt 资产元数据：每个资产必须在 manifest 中登记（ADR-013） */
export interface PromptManifestEntry {
  id: PromptId;
  version: "v1";
  file: string;
  purpose: string;
  requiredVariables: readonly string[];
  optionalVariables: readonly string[];
  outputSchemaId?: string;
  maxRecommendedCharacters?: number;
  tags: readonly string[];
}

/** 人物上下文预算（§21）：超出软预算按优先级裁剪，超出硬限报 PROMPT_BUDGET_EXCEEDED */
export interface CharacterContextBudget {
  maxPromptCharacters: number;
  maxEstimatedTokens: number;
  maxMemoryItems: number;
  maxConversationTurns: number;
  maxKnowledgeItems: number;
}

export const DEFAULT_CHARACTER_CONTEXT_BUDGET: CharacterContextBudget = {
  maxPromptCharacters: 24_000,
  maxEstimatedTokens: 12_000,
  maxMemoryItems: 12,
  maxConversationTurns: 8,
  maxKnowledgeItems: 40,
};

export interface PromptBudgetSegmentReport {
  segment: string;
  characters: number;
  estimatedTokens: number;
}

export interface PromptBudgetReport {
  totalCharacters: number;
  totalEstimatedTokens: number;
  segments: readonly PromptBudgetSegmentReport[];
  /** 为满足预算而被裁剪/丢弃的内容说明（空数组 = 无裁剪） */
  trimmed: readonly string[];
  withinBudget: boolean;
}

export interface ComposedPrompt {
  system: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  manifest: {
    promptIds: readonly PromptId[];
    promptVersions: Readonly<Record<string, string>>;
  };
  budget: PromptBudgetReport;
}
