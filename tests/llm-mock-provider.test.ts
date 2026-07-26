import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MockLLMProvider,
  StructuredOutputError,
  truncateToBudget,
  type LLMMessage,
} from "@mandate/llm-adapters";

const DraftSchema = z.object({
  name: z.string(),
  legitimacyCost: z.number(),
});

describe("MockLLMProvider（FR-LLM-002 离线测试）", () => {
  it("按队列返回预置应答并记录调用", async () => {
    const provider = new MockLLMProvider({ responses: ["第一条", "第二条"] });
    const messages: LLMMessage[] = [{ role: "user", content: "你好" }];

    const r1 = await provider.generate(messages);
    const r2 = await provider.generate(messages);

    expect(r1.text).toBe("第一条");
    expect(r2.text).toBe("第二条");
    expect(r1.provider).toBe("mock");
    expect(r1.usage.totalTokens).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
  });

  it("队列耗尽后使用 handler 兜底", async () => {
    const provider = new MockLLMProvider({ handler: () => "兜底" });
    const result = await provider.generate([{ role: "user", content: "x" }]);
    expect(result.text).toBe("兜底");
  });
});

describe("generateStructured（FR-LLM-003）", () => {
  it("合法 JSON 通过 Schema 校验", async () => {
    const provider = new MockLLMProvider({
      responses: ['{"name":"测试政策","legitimacyCost":5}'],
    });
    const draft = await provider.generateStructured([{ role: "user", content: "x" }], {
      schema: DraftSchema,
    });
    expect(draft).toEqual({ name: "测试政策", legitimacyCost: 5 });
  });

  it("支持 ```json 围栏包裹的输出", async () => {
    const provider = new MockLLMProvider({
      responses: ['这是草案：\n```json\n{"name":"围栏","legitimacyCost":1}\n```'],
    });
    const draft = await provider.generateStructured([{ role: "user", content: "x" }], {
      schema: DraftSchema,
    });
    expect(draft.name).toBe("围栏");
  });

  it("前两次非法、第三次合法：重试后成功", async () => {
    const provider = new MockLLMProvider({
      responses: ["不是 JSON", '{"name":"缺字段"}', '{"name":"成功","legitimacyCost":3}'],
    });
    const draft = await provider.generateStructured([{ role: "user", content: "x" }], {
      schema: DraftSchema,
      maxRetries: 2,
    });
    expect(draft.name).toBe("成功");
    expect(provider.calls).toHaveLength(3);
  });

  it("重试耗尽后抛 StructuredOutputError", async () => {
    const provider = new MockLLMProvider({ responses: ["bad", "bad", "bad"] });
    await expect(
      provider.generateStructured([{ role: "user", content: "x" }], {
        schema: DraftSchema,
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});

describe("truncateToBudget（上下文裁剪）", () => {
  it("保留 system 消息并丢弃最早的对话", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "你是魏忠贤" },
      { role: "user", content: "早".repeat(200) },
      { role: "assistant", content: "臣在".repeat(200) },
      { role: "user", content: "最近的奏折" },
    ];
    const result = truncateToBudget(messages, 50);
    expect(result[0]?.role).toBe("system");
    expect(result.some((m) => m.content === "最近的奏折")).toBe(true);
    expect(result.length).toBeLessThan(messages.length);
  });
});
