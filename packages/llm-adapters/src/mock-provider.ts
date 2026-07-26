import { BaseLLMProvider } from "./base-provider";
import { estimateUsage } from "./context";
import type { LLMGenerateOptions, LLMMessage, LLMResult } from "./types";

export type MockHandler = (messages: LLMMessage[]) => string;

export interface MockLLMProviderOptions {
  /** 预置应答队列：每次 generate 消费一条 */
  responses?: string[];
  /** 队列耗尽后的兜底应答函数 */
  handler?: MockHandler;
  /** 返回结果中的模型标识；默认与运行时配置一致 */
  model?: string;
}

/**
 * Mock 供应商：零网络，支撑全部核心测试（FR-LLM-002）。
 * 记录全部调用以便断言；token 用量为估算值。
 */
export class MockLLMProvider extends BaseLLMProvider {
  readonly name = "mock";

  private readonly queue: string[];
  private readonly handler?: MockHandler;
  private readonly model: string;
  /** 全部调用的消息副本（测试断言用） */
  readonly calls: LLMMessage[][] = [];

  constructor(options: MockLLMProviderOptions = {}) {
    super();
    this.queue = [...(options.responses ?? [])];
    this.model = options.model ?? "mock-model";
    if (options.handler !== undefined) {
      this.handler = options.handler;
    }
  }

  /** 追加一条预置应答 */
  enqueue(text: string): void {
    this.queue.push(text);
  }

  generate(messages: LLMMessage[], _options: LLMGenerateOptions = {}): Promise<LLMResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const text =
      this.queue.length > 0
        ? (this.queue.shift() as string)
        : this.handler
          ? this.handler(messages)
          : "";
    return Promise.resolve({
      text,
      model: this.model,
      provider: this.name,
      usage: estimateUsage(messages, text),
    });
  }
}
