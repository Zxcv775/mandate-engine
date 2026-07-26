# ADR-020：Agent 回合两阶段提交与恢复

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

Provider 调用秒级且可能失败；不能让它占用 SQLite 写事务，也不能让重试产生重复发言。

## 决策

- 阶段 A（原子）：状态机 await-agent + pendingAgentAction{actionId,...} 落库，
  meetingVersion+1；actionId 取调用方 idempotencyKey 或系统生成。
- Provider 调用在一切事务之外；失败则状态机 fail（failureCode 记录），pending 保留。
- 阶段 B（原子）：commitAgentTurn 校验当前 pending.actionId 匹配 → 同一事务内
  追加 turn（携带 actionId）+ 更新会议 head；UNIQUE(turn_number)/UNIQUE(action_id)
  下任何重放都以 MEETING_AGENT_RESPONSE_DUPLICATE 幂等拒绝。
- 恢复：重启后 findPendingAgentSessions 定位；failed→pause→resume 后 step 沿
  pendingAgentAction 以同一 actionId 重试（重新宣告 await-agent）；若该 actionId
  已有回合则只做收尾清理。

## 状态写边界

两阶段只写会议表；世界 revision 不变。

## 替代方案

单事务包住 Provider 调用：WAL 写锁被网络时延持有，不可接受。

## 一致性影响 / 恢复路径

见上；stale meetingVersion / stale revision 一律 409，绝不悄悄基于新状态续答。

## 安全影响

actionId 幂等锚点防重放；pending 中会议拒绝并发第二个 Agent 请求。

## 回退方案

可配置为纯同步模式（禁真实 Provider 时 Mock 即时返回，两阶段仍成立）。

## 测试影响

tests/meeting-recovery.test.ts：预留/stale/幂等/append-only/跨进程恢复全矩阵。

## 后续升级

超时 pending 的自动取消策略（当前手动 pause/cancel）可按运营需要加定时器。
