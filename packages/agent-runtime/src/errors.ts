import type { ApiErrorCode } from "@mandate/domain";

/** Agent Runtime 统一错误：code 对齐 domain 的 ApiErrorCode，便于 API 层直接映射 */
export class CharacterAgentError extends Error {
  constructor(
    readonly code: Extract<
      ApiErrorCode,
      | "CHARACTER_NOT_FOUND"
      | "CHARACTER_NOT_AVAILABLE"
      | "CHARACTER_CONTEXT_STALE"
      | "CHARACTER_VIEW_BUILD_FAILED"
      | "CHARACTER_MEMORY_INVALID"
      | "CHARACTER_MEMORY_LIMIT_EXCEEDED"
      | "CHARACTER_OUTPUT_INVALID"
      | "CHARACTER_CONSISTENCY_FAILED"
      | "PROMPT_BUDGET_EXCEEDED"
      | "LLM_OUTPUT_REPAIR_FAILED"
    >,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CharacterAgentError";
  }
}
