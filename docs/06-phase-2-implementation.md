# 06 · Phase 2 实施说明

## 1. 范围与结果

Phase 2 将只读历史 ScenarioBundle 实例化为独立 GameState，并建立了完整闭环：

```text
ScenarioBundle → GameState → 白名单 Command → Mutation Plan
→ SQLite 原子事务 → StateChangeLog/hash chain → checkpoint/replay
→ validate/rollback/export/import → API/CLI/Save Browser
```

本阶段没有实现人物 Agent、完整会议、政策解析、规则结算或正式游戏 UI。

## 2. 模块责任

- `@mandate/domain`：GameState、Command、Mutation、StateChangeLog、存档/API Zod Schema 与只读视图。
- `@mandate/game-engine`：确定性 RNG、Clock、stable JSON/hash、Mutation Applier、StateEngine 和初始状态实例化。
- `@mandate/save-system`：`node:sqlite` 连接、migration、Repository、GameStateService、checkpoint/replay、
  validation、repair dry-run、逻辑回滚及 `.mesave` 导入导出。
- `apps/server`：只做 Schema 边界、Service 调用、统一 Envelope 与错误映射，不直接修改状态。
- `apps/web`：统一 Save API Client、Zustand 只读派生状态、存档列表/GameState 摘要/日志过滤。

依赖方向为：

```text
@mandate/domain
       ↑
@mandate/game-engine
       ↑
@mandate/save-system（应用服务 + SQLite adapter）
       ↑
apps/server → HTTP API → apps/web API client
```

## 3. 事务与 revision

`GameStateService.commitCommand()` 是应用层唯一提交入口。Repository 使用 `BEGIN IMMEDIATE`，并将
validate/apply/finalize 分为 SAVEPOINT。状态、transaction、日志、head 与 periodic snapshot 任一失败都会整体 rollback。

- 成功世界事务只增加一次 revision；同一事务日志用 sequence 排序。
- checkpoint 不改变世界状态，不增加 revision。
- idempotencyKey 在同一 save 内唯一，重复请求返回先前提交结果。
- baseRevision 与 head 不一致时返回 `STATE_REVISION_CONFLICT`。

## 4. SQLite 与迁移

默认开发数据库为 `./saves/mandate-engine.sqlite`，测试使用 `:memory:` 或临时文件。连接启用 foreign key、
WAL、5 秒 busy timeout、defensive mode；所有表为 STRICT，SQL 参数化。

核心表：

| 表 | 用途 |
| --- | --- |
| `saves` | 存档元数据、状态、head revision、lineage |
| `command_transactions` | 命令事务、幂等键与提交摘要 |
| `save_snapshots` | initial/periodic/manual/pre_migration/pre_import 快照 |
| `state_change_log` | 追加 mutation、inverse、visibility 与 hash chain |
| `schema_migrations` | 数据库迁移 checksum registry |
| `save_state_migrations` | 单存档状态迁移和备份 checkpoint |
| `import_history` | 包 hash、来源客户端与冲突分类 |

状态迁移前创建 `pre_migration` checkpoint，在同一事务中迁移 snapshot、兼容路径和 hash chain；完整 validate
通过后才 commit。Phase 2 示例为 `country.treasury → country.treasuryTaels`。

## 5. checkpoint、replay 与回滚

- revision 0 必有 initial snapshot；默认每 50 revision 建 periodic checkpoint，可通过配置调整。
- 加载 revision 时选择最近的非 `pre_migration` snapshot，验证 snapshot hash 后顺序应用日志。
- 逻辑回滚先 dry-run 展示路径，再创建 pre-rollback checkpoint，将目标状态作为新 `save.rollback` 事务提交。
- 旧 revision 不删除；例如 revision 3 回滚到 1 会创建 revision 4。

## 6. 导入导出与安全分享

`.mesave` 是 ZIP 容器，固定包含 `manifest.json`、`payload.sqlite`、`checksums.json`。SQLite payload 通过
Backup API 生成；可选 AES-256-GCM + scrypt 口令加密。导入在接触本地存档前校验条目白名单、checksum、
manifest 版本和 SQLite integrity。

冲突分类：`noop`、`fast_forward`、`forked`、`rejected`。分叉默认创建独立 save，不覆盖任一世界线。
`safe_share` 可剥离 source catalog 与 sealed 数据，但 state 中的 sourceIds 仍保留，并标记 catalog 缺失。

原始 RNG seed 只保存 SHA-256；凭据样式字符串在持久化边界摘要脱敏。API、普通 StateChangeLog 查询和
Save Browser 均不返回 hidden/sealed。

## 7. API 与 CLI

Save API 全部沿用 `{ok,data|error,meta:{requestId}}`：

```text
POST   /api/saves
GET    /api/saves
GET    /api/saves/:saveId
GET    /api/saves/:saveId/state
GET    /api/saves/:saveId/changes
POST   /api/saves/:saveId/commands
POST   /api/saves/:saveId/time/advance
POST   /api/saves/:saveId/checkpoints
POST   /api/saves/:saveId/validate
POST   /api/saves/:saveId/repair
POST   /api/saves/:saveId/rollback
POST   /api/saves/:saveId/export
POST   /api/saves/import
POST   /api/saves/:saveId/migrate
DELETE /api/saves/:saveId
```

CLI 复用同一个 GameStateService：

```bash
npm run save:check -- --save ./saves/mandate-engine.sqlite --json
npm run save:repair -- --save <id> --database <path> --dry-run --json
npm run save:rollback -- --save <id> --database <path> --target-revision 37 --dry-run
npm run save:export -- --save <id> --database <path> --out ./tmp/demo.mesave
npm run save:import -- --database <path> --file ./tmp/demo.mesave
npm run save:migrate -- --save <id> --database <path>
```

CLI 成功退出码为 0；校验报告失败为 1；参数错误为 2；操作错误为 3。错误输出不回显 password 或内部 details。

## 8. 质量门与基准

```bash
npm run check:phase2
```

该命令串行执行 lint、typecheck、全部测试、build、历史数据校验、临时 SQLite 校验、迁移、回滚、完整性和
确定性专项测试。CI 使用 Mock Provider 和临时 SQLite，不需要 Secrets。

真实基准见：

- `docs/progress/phase2-benchmark.json`
- `docs/progress/2026-07-26-phase2-benchmark.md`

正式 fixture 使用 revision 1000、日志 10000、5 次重复，并记录 snapshot/50 与 snapshot/100、来源目录开关和
WAL 观测值。文件页大小受插入顺序和 SQLite 页分配影响，本次 snapshot/100 略大于 snapshot/50，不能据此
推导“更稀疏 checkpoint 必然更小”。

## 9. Phase 3 入口

Phase 3 只能读取 `PlayerStateView` / `CharacterStateView`，将候选动作转换为白名单 Command；不得给 Agent、
Prompt 或会议文本增加 GameState/SQLite 写权限。
