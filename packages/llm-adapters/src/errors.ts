/** 供应商调用失败（网络、超时、限流、协议错误等） */
export class LLMProviderError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string, cause?: unknown) {
    super(`[${provider}] ${message}`);
    this.name = "LLMProviderError";
    this.provider = provider;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** 结构化输出在重试后仍无法通过 Schema 校验 */
export class StructuredOutputError extends Error {
  readonly lastError?: unknown;

  constructor(message: string, lastError?: unknown) {
    super(message);
    this.name = "StructuredOutputError";
    this.lastError = lastError;
  }
}
