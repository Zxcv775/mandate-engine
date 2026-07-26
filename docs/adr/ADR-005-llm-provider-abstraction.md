# ADR-005 · LLM 供应商抽象

- 状态：**已接受**
- 日期：2026-07-26

## 背景

LLM 供应商格局变化快，且玩家可能使用云端 API 或本地模型。
业务代码若直接依赖某家 SDK，将被供应商锁定，也无法离线测试。

## 决策

1. 定义统一接口 `LLMProvider`（`packages/llm-adapters`）：
   - `generate(messages, options)` → 文本 + token 用量；
   - `generateStructured(messages, { schema, maxRetries })` → Zod 校验的结构化输出；
   - `generateStream`（可选，Phase 4 启用）；
   - 选项含 temperature、maxTokens、timeoutMs、AbortSignal。
2. 业务代码只依赖接口；供应商经环境变量配置装配（`LLM_PROVIDER` 等）。
3. Phase 0 实现两个适配器：
   - `MockLLMProvider`：队列/函数式应答，零网络，支撑全部核心测试；
   - `OpenAiCompatibleProvider`：基于 Node 内置 fetch 的 OpenAI 兼容端点客户端
     （可对接云端与 LM Studio / Ollama 等本地模型），含超时与指数退避重试。
4. 新增供应商 = 新增适配器类，业务零修改。

## 选择理由

- 供应商可替换、可离线测试（FR-LLM-001/002）；
- 内置 fetch 足够覆盖 OpenAI 兼容协议，避免 SDK 依赖；
- Mock 让核心计算测试永不触网（FR-TEST-001）。

## 替代方案

- 直接用 openai SDK：便捷但锁定接口形态（可在适配器内部未来引入）；
- Vercel AI SDK：多供应商但引入外部抽象锁定与版本耦合，暂拒；
- LangChain 类框架：过重，拒绝。

## 后果

- 正面：测试/离线/多供应商自由切换；依赖面小；
- 负面：重试、超时、用量统计需自维护（代码量小，已覆盖）；
- 特殊能力（工具调用、视觉）需要时再扩展接口，不做提前设计。

## 风险

- OpenAI 兼容端点的实现差异 → 以 Mock 与集成测试兜底；
- 接口设计不足 → 遵循"最小可用、按需扩展"，扩展须经 ADR 增补。
