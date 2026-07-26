# ADR-006：本地存档采用 SQLite

## 状态

已接受（2026-07-26，Phase 2）。

## 背景

GameState、命令事务、快照和 StateChangeLog 必须原子落盘，并能按 revision 查询、校验和导出。
纯 JSON 文件无法可靠提供并发控制、外键和多记录事务；活跃 WAL 下复制主文件也可能得到不一致备份。

## 决策

- 正式本地存档使用 Node 24 的 `node:sqlite` `DatabaseSync`，实现集中在 `@mandate/save-system`。
- 开启 `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000` 和 defensive mode；表使用 `STRICT`。
- 固定表为 `saves`、`command_transactions`、`save_snapshots`、`state_change_log`、
  `schema_migrations`、`save_state_migrations`、`import_history`，所有 SQL 使用 prepared statement。
- 世界状态采用 snapshot + 追加日志；导出通过 Backup API 生成独立 SQLite payload，再封装为 `.mesave`。
- 不开启扩展加载，不接受用户或 LLM 提供的 SQL、表名或列名。

## 选择理由

SQLite 在单机游戏中同时提供原子事务、索引、约束、完整性检查和便携文件；Node 内置实现避免原生第三方驱动，
薄 Repository 又把实验 API 的影响限制在一个包内。

## 替代方案

- 纯 JSON：结构简单，但无法保证状态、日志、revision 与 checkpoint 的同一事务提交。
- 外部 SQLite 驱动：能力成熟，但增加原生构建和分发成本。
- 云数据库：超出离线单机范围，并引入部署与凭据依赖。
- 直接复制 WAL 中的 `.sqlite`：存在一致性风险，因此不采用。

## 缺点

`DatabaseSync` 会同步占用事件循环；`node:sqlite` 在 Node 24 仍显示 experimental 警告；SQL schema 与领域
Schema 需要双边一致性测试。

## 风险

大日志量会增加文件和 validate 时间；异常退出可能保留 WAL 文件；Node API 变动可能影响适配层。

## 回退方案

导入和迁移前保留 checkpoint/备份；损坏文件不原地伪造历史，通过 `.mesave` 或迁移前备份恢复。
若 `node:sqlite` 出现不可接受的不兼容，仅替换 Repository/Database adapter，不改变 Domain 与 Service 契约。

## 对测试的影响

Repository、事务失败注入、外键、WAL 导出、integrity check、迁移和导入导出全部使用临时数据库；测试不得写开发存档。

## 对兼容性的影响

运行基线固定为 Node 24.18.0 / npm 11.16.0。正式交换格式是带 manifest/checksum 的 `.mesave`，不是裸数据库复制。
