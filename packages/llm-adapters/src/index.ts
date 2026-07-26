/**
 * @mandate/llm-adapters —— LLM 供应商抽象（ADR-005）。
 * 业务代码只依赖 LLMProvider 接口；新增供应商 = 新增适配器类。
 */
export * from "./types";
export * from "./errors";
export * from "./context";
export * from "./base-provider";
export * from "./mock-provider";
export * from "./openai-compatible-provider";
