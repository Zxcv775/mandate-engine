# ADR-008：存档前向迁移与导入分叉策略

## 状态

已接受（2026-07-26，Phase 2）。

## 背景

SQLite 表结构、GameState 文档和交换包版本会独立演进。导入包还可能与本地 save 同源但不同 head，静默覆盖会丢失世界线。

## 决策

- 数据库迁移和状态文档迁移都只向前；每个迁移有唯一 ID、from/to version 与 SHA-256 checksum。
- 数据库迁移记录在 `schema_migrations`；存档状态迁移记录在 `save_state_migrations`。
- 状态迁移在 `BEGIN IMMEDIATE` 内创建 `pre_migration` checkpoint、转换 snapshot/兼容日志路径、重建 hash chain、
  更新 head hash、执行完整 validate 后才 commit；失败整体 rollback。
- 示例迁移 `state-001-treasury-taels` 将 `country.treasury` 改为 `country.treasuryTaels`。
- 不提供 down migration；回退方式是恢复迁移前 checkpoint/备份。
- 导入先校验 ZIP 条目、manifest、版本、checksum 和 SQLite integrity，再分类：相同包为 `noop`、本地为祖先时
  `fast_forward`、分叉时默认建立独立 `forked` save、不兼容时 `rejected`。

## 选择理由

前向迁移可重复、可审计，避免 down migration 猜测已经丢失的语义；分叉默认 fork 同时保留本地与导入世界线，
比自动 merge 或覆盖更安全。

## 替代方案

- 每次启动即时兼容读取：分支持续膨胀，无法证明写回结果。
- 自动 down migration：新字段通常没有无损逆映射。
- 分叉自动 merge：GameState 不是可交换 CRDT，数值与事件顺序无法安全合并。
- 分叉覆盖本地：会直接丢失历史，因此禁止。

## 缺点

迁移需要额外快照和一次全量校验；大存档迁移会同步占用较长时间；fork 会增加磁盘占用。

## 风险

迁移 checksum 漂移、版本断档、旧日志路径不兼容或备份空间不足会阻断升级。

## 回退方案

事务失败自动回滚；commit 后若发现问题，关闭新文件并恢复 `pre_migration`/导出备份。原始导入包始终保持只读。

## 对测试的影响

测试包含纯函数 fixture、真实 legacy SQLite、迁移 checksum 唯一性、重复 no-op、失败回滚、旧版导入、
noop/fast-forward/forked/rejected 和迁移后 validate。

## 对兼容性的影响

高于当前 state/export version 的存档拒绝加载；低版本必须有连续迁移链。迁移 ID 和 checksum 一经发布不可改写。
