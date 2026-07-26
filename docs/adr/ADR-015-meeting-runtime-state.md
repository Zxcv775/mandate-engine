# ADR-015：会议运行态双层存储

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

会议既需要进入世界状态（可审计、可回放），又有高频内部推进（回合/议程/发言者）不适合
每步都产生世界 revision 与 StateChangeLog。

## 决策

- GameState.meetings 只保存最小投影（现有 Schema + optional chairCharacterId/visibility，
  无 stateVersion 迁移），仅由 meeting.create/start/conclude/cancel 四个 GameCommand 经
  StateEngine 更新（每次生命周期转换 revision+1、入 StateChangeLog；conclude 可携带
  泄密候选事件写入 hidden.queuedEventIds 的 sealed mutation）。
- 富运行态（12 态状态机、议程、回合计数、发言者、pendingPlayerAction/pendingAgentAction、
  meetingVersion）存 SQLite meeting_sessions，由纯函数状态机 transitionMeeting 推进，
  仓储以 meetingVersion 乐观锁落库；会议内部步进不产生世界 revision。
- game-engine 的 applyMutation 为此获得 add/remove 逐键语义（与 inverse 对称、可回滚）。

## 状态写边界

世界状态仍只经 StateEngine；会议表写入不产生 StateChangeLog（发言不是世界事实）。

## 替代方案

- 富运行态全进 GameState：每回合 revision+1，日志爆炸，且要求 stateVersion 迁移。
- 全部只放 SQLite：会议存在与否对角色视图不可见，破坏 Phase 3 的会议可见性过滤。

## 一致性影响 / 恢复路径

投影与富态以 meetingId 关联；投影只在生命周期节点变化，崩溃后以 SQLite 富态为准恢复，
投影按命令历史可重放。

## 安全影响

sealed 会议的投影 mutation 以 sealed visibility 记录；普通日志投影不可见。

## 回退方案

不用会议功能即可完全绕开；迁移 003 为纯新增表。

## 测试影响

tests/meeting-state.test.ts：15 事件 × 11 状态全矩阵 + 命令生命周期 + 重放确定性。

## 后续升级

Phase 5+ 若需会议影响政策合法性，经 conclude 命令携带的确定性 payload 扩展。
