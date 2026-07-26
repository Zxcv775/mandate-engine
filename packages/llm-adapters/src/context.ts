import type { LLMMessage, LLMUsage } from "./types";

/**
 * 粗略 token 估算（中文约 1.5-2 字符/token，取保守值）。
 * 仅用于预算与裁剪；精确用量以供应商返回的 usage 为准。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function estimateMessagesTokens(messages: readonly LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export function estimateUsage(messages: readonly LLMMessage[], completionText: string): LLMUsage {
  const promptTokens = estimateMessagesTokens(messages);
  const completionTokens = estimateTokens(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/**
 * 上下文裁剪：保留全部 system 消息与最近的对话，超出预算时从最早的
 * 非 system 消息开始丢弃。返回新数组，不修改入参。
 */
export function truncateToBudget(
  messages: readonly LLMMessage[],
  budgetTokens: number,
): LLMMessage[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  const kept: LLMMessage[] = [];
  let budget = budgetTokens - estimateMessagesTokens(system);

  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i] as LLMMessage;
    const cost = estimateTokens(msg.content) + 4;
    if (budget - cost < 0) break;
    budget -= cost;
    kept.unshift(msg);
  }
  return [...system, ...kept];
}
