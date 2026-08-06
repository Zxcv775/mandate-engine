/** 规则引擎错误：code 对齐 API 错误码清单（§6.5），由 server 层映射 HTTP 状态。 */
export type RuleEngineErrorCode =
  | "RULE_NOT_FOUND"
  | "RULE_SCHEMA_INVALID"
  | "RULE_EFFECT_UNSUPPORTED"
  | "RULE_CONDITION_PATH_FORBIDDEN"
  | "MODIFIER_INVALID"
  | "MODIFIER_TARGET_NOT_FOUND";

export class RuleEngineError extends Error {
  constructor(
    readonly code: RuleEngineErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RuleEngineError";
  }
}
