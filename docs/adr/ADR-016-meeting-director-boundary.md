# ADR-016：Meeting Director 边界

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

多人物会议需要编排器，但编排器绝不能成为世界裁判或让 LLM 决定规则。

## 决策

- packages/meeting-engine 新包：仅依赖 domain+shared，禁止依赖 llm-adapters/agent-runtime
  （与 game/rule/event-engine 同级红线）。
- planNextStep 为纯确定性函数：对话类玩家动作直达、七类上限检查（会议/议程/单人连续/
  单人总量/连续 Agent/连续反驳/无合格发言者）、议程推进、调度选人；决策不含任何 LLM 调用。
- LLM 调用由 server 层 MeetingService 按 Director 决策执行；资格所需的知识访问级别由
  server 用 agent-runtime 可见性策略预计算后以参数传入。
- 管理类玩家动作（授予/剥夺发言权、暂停、延后、裁决、散会）由 service 直接执行，
  不经 Director。

## 状态写边界

Director 无任何写操作；其决策只是建议给 service 的下一步。

## 替代方案

LLM 主持人：不可复现、不可离线 CI、无法保证单线程与上限（明确禁止）。

## 一致性影响 / 恢复路径

存在 pendingAgentAction 时 Director 拒绝规划（MEETING_AGENT_REQUEST_PENDING），
恢复由 service 的两阶段协议处理。

## 安全影响

恶意玩家文本只能成为回合数据，无法改变 Director 决策逻辑。

## 回退方案

Director 可被替换为纯手动模式（每步玩家点名）而不影响存储层。

## 测试影响

tests/meeting-scheduler.test.ts Director 决策树用例；meeting-security 恶意输入矩阵。

## 后续升级

Phase 5 politics 权重可作为纯数据注入评分函数，不改边界。
