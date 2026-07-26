# 2026-07-26 · Phase 2 实施记录

## 基线

- 分支：`main`，初始 HEAD `55b96aa`，与 `origin/main` 同步。
- Phase 1 成果位于未提交工作树，本阶段在其上精准追加并保留全部既有修改；未创建分支、commit 或 push。
- 固定环境：Node 24.18.0 / npm 11.16.0；Phase 1 基线 86/86 测试及 lint/typecheck/build/check:data 全绿。
- `node:sqlite` 实测具备 DatabaseSync、createSession、applyChangeset、backup、serialize、deserialize；本阶段使用
  DatabaseSync 与 Backup API。

## 实施结果

- Domain：strict GameState、Command、Mutation、StateChangeLog、Save/API Schema 与 Player/Character/Debug View。
- Engine：immutable mutation、inverse、baseRevision、固定 Clock、seed/cursor RNG、stable JSON/SHA-256、时间推进。
- Save System：STRICT SQLite、WAL、原子事务/SAVEPOINT、幂等、checkpoint/replay、append-only hash chain、
  logical rollback、validate、repair dry-run、前向迁移。
- Exchange：`.mesave` manifest/payload/checksums、Backup API、AES-256-GCM+scrypt、safe-share、
  noop/fast-forward/forked/rejected。
- Surface：15 个 Save API、6 个 save CLI、Runtime Dashboard Save Browser、日志过滤与 hidden/sealed 边界。
- Quality：临时 SQLite 自检、迁移/回滚/完整性/确定性 CI 门、安全凭据持久化回归和参数化性能基准。

## 性能证据

固定 Node 24.18.0、Windows 10.0.26100、Ryzen 9 8940HX、16 GiB 环境：

- Fixture：1000 revision、10000 StateChangeLog、每个可重复操作 5 次。
- create save 23.902 ms；单领域 mutation 事务平均 3.935 ms；10 mutation 事务平均 4.546 ms。
- load revision 0/100/1000 平均 0.321/0.211/0.221 ms。
- replay 50/100 revision 平均 4.597/6.896 ms。
- export/import/validate 平均 157.214/154.233/73.872 ms。
- 10000 日志数据库 11,554,816 bytes；单日志估算负载 248.946 bytes；WAL 观测 4,185,952 bytes。
- snapshot/50 与 /100 文件为 2,973,696 / 3,076,096 bytes；页分配导致本次结果不单调，未作比例外推。
- 含来源目录/安全剥离导出为 681,899 / 5,013 bytes。

完整数据：`phase2-benchmark.json` 与 `2026-07-26-phase2-benchmark.md`。

## 验证状态

- 自动测试：174/174 通过（固定 Node 24.18.0 / npm 11.16.0）。
- `npm run check:phase2` 全链通过；迁移 12/12、逻辑回滚 3/3、完整性/导入导出 36/36、
  确定性 15/15 均单独复核通过。
- Save API 回归确认未知剧本稳定映射为 `SCENARIO_NOT_FOUND/404`，数据加载内部错误不向响应泄露细节。
- Lint 负向验证：临时未使用变量触发 warning，`--max-warnings=0` 按预期返回非零；临时文件删除后恢复全绿。
- 浏览器联调：实际确认 Mock Provider、`chongzhen-early`、Schema 状态；创建 `save_manual` 后 UI 显示
  revision 0/GameState 摘要，提交资源命令后显示 revision 1、国库变更与 3 条审计日志，aggregate 过滤有效；
  关闭 Server 后全部卡片进入明确离线状态。联调 SQLite/JSON/进程均已清理。
- 远端 GitHub Actions：本会话未 push，未触发；workflow 仅完成本地静态与命令序列验证。

## 下一步边界

Phase 3 尚未开始。只能在人工评审后实现人物卡运行时视图、角色知识过滤、Prompt 资产扩展、单人物
Character Agent 原型与会议上下文构建器。
