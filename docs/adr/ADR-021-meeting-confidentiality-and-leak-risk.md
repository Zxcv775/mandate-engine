# ADR-021：会议保密与泄密风险

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

秘密议事的价值在于信息不对称；泄密必须是确定性规则而非 LLM 的即兴决定。

## 决策

- 保密分层：会议/议程/回合三级 visibility（court/meeting/private/sealed）；
  秘密议事回合默认 private，sealed 议程下的回合为 sealed。
- 隔离：非参与者的角色视图与 Prompt 完全不见秘密会议（Phase 3 可见性策略沿用）；
  普通 Transcript API 投影 ≤ meeting；私密纪要按参与者授权；safe_share 导出删除
  sealed/private 回合、私密纪要、泄密评估与秘密会议 session。
- 泄密评估（会议结束时）：确定性评分（类型基准取 DEFAULT_MEETING_RULES.
  baseLeakProbability、人数、机密议题、参与者谨慎/忠诚/压力、政敌在座、行政保密能力）；
  仅秘密议事做确定性 roll（SeededRng，种子派生自存档 rng seed + meetingId，
  记录 seedCursorBefore/roll/threshold）；触发只把候选事件 id 经 meeting.conclude
  命令写入 hidden.queuedEventIds（sealed mutation），不展开后果。

## 状态写边界

泄密后果只是隐藏队列中的候选事件；消费属 Phase 5+ 事件引擎。

## 替代方案

LLM 判定泄密：不可复现（明确禁止）；即时展开后果：越出本阶段边界。

## 一致性影响 / 恢复路径

同 seed 同输入结果一致；评估落库 INSERT OR REPLACE 可重算。

## 安全影响

potentialAudienceIds 只来自确定性关系数据；评估仅 Debug API 可见。

## 回退方案

评估可禁用（不写 hidden 队列），保密分层独立生效。

## 测试影响

tests/meeting-memory-leak.test.ts §21.9 全项 + meeting-security 秘密隔离。

## 后续升级

Phase 5 事件引擎消费 leak 候选事件时，将风险因素并入事件参数。
