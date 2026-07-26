# ADR-014：Character Agent 输出契约

## 状态

已接受（2026-07-26，Phase 3）。

## 背景

LLM 输出不可信；Agent 发言必须是结构化建议而非状态变更。需要严格契约 + 受控修复 +
确定性一致性检查，并把内部评估与玩家可见内容隔离。

## 决策

- 模型输出契约 `CharacterAgentModelOutput`（strict Zod）：speech / stance / internalAssessment? /
  emotionalState / claims(basis+confidence+sourceIds) / proposedActions / memoryCandidates /
  uncertaintyNotes。系统补全 characterId 与 trace（provider/model/promptVersions/
  stateRevision/durationMs/repaired）成为 `CharacterAgentResult`。
- Agent 零写权限：编排链路（stale 检查 → 可交谈检查 → Context Builder → Composer →
  Provider → 修复 → 一致性）中无任何 GameState/SQLite/StateChangeLog 写操作；
  proposedActions 仅是建议对象，八种类型全部不含 mutation 语义。
- `expectedRevision` 强校验：head 前进即返回 `CHARACTER_CONTEXT_STALE`，绝不基于新状态续答。
- 受控修复：不用 BaseLLMProvider 的同消息盲重试；失败后发送专用修复 Prompt
  （仅含输出契约 + 原输出 + 安全化错误摘要，不重发人物上下文），次数可配置（默认 1）；
  禁用修复时首败 `CHARACTER_OUTPUT_INVALID`，修复穷尽 `LLM_OUTPUT_REPAIR_FAILED`。
- 一致性检查为确定性规则（不引入 LLM 裁判）：PROMPT_LEAK / NUMERIC_LEAK /
  STATE_MUTATION_CLAIM / UNKNOWN_INFO_CLAIM / VENUE_VIOLATION 为 error（阻断，
  `CHARACTER_CONSISTENCY_FAILED`）；MODERN_LANGUAGE / STANCE_FLIP 为 warning。
- 可见性投影：玩家 API 只返回 `CharacterPublicResponse`（剥离 internalAssessment、
  memoryCandidates 与 trace 细节）；internalAssessment 仅 Debug API（生产默认 404）。
- 对话记录只是交互存证（独立表），不是世界事实；审计走结构化日志
  （不含 Prompt 正文与密钥），不进 StateChangeLog。

## 选择理由

"建议而非事实"的契约让 LLM 全量输出都可被系统与玩家否决；确定性检查器保证 CI 可复现；
双错误码区分"没开修复"与"修复失败"，便于观测。

## 替代方案

- 让 Agent 返回候选 Mutation：一步之遥即状态写权限，违反 ADR-002。
- LLM 作为一致性裁判：不确定、不可离线、成本高（明确排除为唯一裁判）。

## 后果

真实模型需要能稳定输出 JSON；靠输出契约段 + 一次修复兜底，仍失败则显式报错。

## 风险

正则规则可能误伤合法文言（如"臣已拨冗"类措辞）——规则集中一处，可按误报迭代。

## 回退方案

Agent 层可整体停用（路由不注册），Phase 2 功能不受影响。

## 测试影响

`tests/character-agent.test.ts` 21 用例 + `character-security.test.ts` 10 用例 +
`phase3-integration.test.ts` 5 闭环：立场/场合/修复/超时/stale/不可交谈/状态不变/
泄露拦截/恶意输入矩阵。

## 兼容性影响

新增错误码 12 个进入统一 `ApiErrorCodeSchema`；Envelope 与既有错误处理链不变。
