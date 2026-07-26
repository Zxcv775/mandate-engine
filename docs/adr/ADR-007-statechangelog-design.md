# ADR-007：StateChangeLog、revision 与逻辑回滚

## 状态

已接受（2026-07-26，Phase 2）。

## 背景

运行状态必须可审计、可重放并能解释每次变化。覆盖旧快照或物理删除历史会破坏调查、幂等和分叉判断。

## 决策

- 一个成功世界状态事务只增加一次 revision；同一事务的日志共享 revision，以 sequence 排序。
- checkpoint 不改变世界事实，因此不增加 revision。
- 每条日志保存 before/after、inverse、actor、command、sourceIds、visibility 和前后 state hash。
- `entryHash = SHA-256(stable JSON(entry without entryHash))`，其中包含 `prevLogHash`，形成追加式哈希链。
- 普通 API 和 Dashboard 过滤 `sealed` 日志；完整 hidden/sealed 仅存在内部 DebugStateView。
- 回滚是 `save.rollback` 新命令：先创建 pre-rollback checkpoint，再将目标 revision 的事实作为新 mutation 提交；
  被回滚的 revision 保留，新 head 获得新的 revision。

## 选择理由

追加日志让审计、重放、冲突分类和问题定位使用同一事实记录；逻辑回滚不会重写 hash chain，也避免引用旧 revision
的外部记录失效。

## 替代方案

- 只保存最新 JSON：无法审计或回放。
- 物理删除 revision：破坏哈希链、导入 lineage 与可追溯性。
- SQLite changeset 作为唯一日志：依赖二进制表级差异，难以表达领域原因、来源和 visibility。

## 缺点

日志与 inverse 增加存储体积；复杂结构的 before/after 可能较大；哈希链只能发现篡改，不能阻止有权限者重写整条链。

## 风险

日志缺口、sequence 冲突或错误路径会导致 replay 失败；无法安全生成 inverse 的未来操作不能使用普通逻辑回滚。

## 回退方案

优先从最近有效 snapshot 重放；inverse 不适用时从 checkpoint + 日志恢复。校验失败时保持原文件，只输出 repair dry-run。

## 对测试的影响

测试覆盖多 mutation 原子性、revision 一次递增、inverse、日志失败回滚、hash chain 篡改检测、replay 与
revision 0→1→2→3→逻辑回滚→4。

## 对兼容性的影响

日志字段和 stable serialization 属于存档兼容契约；修改字段或散列规范必须增加前向迁移，不能静默改变既有 entryHash。
