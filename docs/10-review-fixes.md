# 10 · 代码审查问题修复说明

本轮只加固 Phase 2–5 既有边界，不进入 Phase 6，不增加真实 LLM 或联网依赖。

## 1. 一致性与事务

- **REVIEW-001**：migration 005 增加追加式 `save_rollback_events`。历史会议、政策明细和成本账本保留；
  当前态查询通过回滚事件构造时间线投影。导出/导入携带该投影，safe-share 使用压平后的当前快照。
- **REVIEW-002**：Save Repository 提供同连接 `BEGIN IMMEDIATE` 事务与嵌套 savepoint；会议世界状态、
  session、transcript、turn、纪要、泄密与裁决批次在一个提交边界内完成。migration 007 记录裁决级
  idempotency key、request hash 与结果；同请求重放原结果，不同请求返回 409。
- **REVIEW-005**：幂等身份为 `idempotencyKey + SHA-256(canonical actor/payload)`；同请求重放返回
  `idempotent: true`，同 key 不同请求返回 409。事务提交前再次检查，覆盖并发竞态。
- **REVIEW-012**：命令计划移除 `before === after` 的 mutation；业务 mutation 为空时返回
  `POLICY_NO_CHANGES`，不增长 revision，不写空日志。

## 2. Agent、导出与导入边界

- **REVIEW-003**：safe-share 同时剥离 confidential meeting 的 GameState 摘要、session 子表、
  private/sealed turn、纪要、泄密评估、关联记忆和 hidden 政策明细。
- **REVIEW-004**：LLM 返回后、任何持久化前重新读取 head revision 与人物/会议状态；发生漂移时返回 409，
  丢弃陈旧响应。
- **REVIEW-006/007**：HTTP body、base64 DTO、压缩包、entry 数量/大小、总解压量、压缩比、文件名、
  路径深度、重复项、加密/ZIP64 与白名单均有独立上限；先解析中央目录再解压。
- **REVIEW-011**：人物数值只以五档定性文本进入 Prompt；一致性检查覆盖阿拉伯数字、全角数字、
  中文数字、百分号与常见字段/措辞。

## 3. 政策与规则

- **REVIEW-008**：提出与调整共用责任校验：机构必须匹配，责任人须在职、任允许官职且与 OfficeHolder 一致。
- **REVIEW-009**：阻滞恢复首 tick 重新扣费；行政容量按单次结算周期、policyId 稳定排序分配，
  只占用不永久扣减。migration 006 增加追加式 `policy_cost_applications`，记录 required/applied/before/after。
- **REVIEW-010**：`remove-modifier.bySource` 使用结构化 `ModifierSource`，按 kind 与具体 ID/label 精确比较。
- **REVIEW-013**：README、领域模型、路线图、AGENTS 与专项测试脚本同步到 Phase 5 实际状态。

## 4. 验证入口

```bash
npm run check:review-fixes
npm run check:phase5
```

专项测试均使用 Mock Provider 与临时 SQLite；不读取真实凭据，不访问网络，不写开发存档。

## 5. 第二轮聚焦修复

- **REVIEW-003**：safe-share 对源自秘密会议的公开政策保留客观状态，同时把 `origin` 重写为
  不含可关联标识的 `redacted` 来源；全包、SQLite 全表和导入后状态均不得恢复秘密会议来源。
- **REVIEW-001**：migration 008 增加 meeting session、participant、agenda item、outcome candidate 与
  leak assessment 的追加式版本表；所有运行态读取按当前回滚祖先链投影。`meeting_turns` 的唯一键加入
  `state_revision`，允许在新分支合法重演同一 turn number。
- **REVIEW-008**：`policy.resume` 与 issue/adjust 共用当前状态责任人校验，失去官职或人物资格时保持
  paused 且不产生 revision、日志、报告、成本或资源变动。
- **REVIEW-006**：解压前交叉核对 ZIP local header 与 central directory 的 flags、method、CRC、大小、
  文件名和边界，并拒绝加密、ZIP64、重叠区域及当前不支持的 data descriptor。
- **REVIEW-012**：责任人第一位保留主负责人语义；仅对其余协办负责人做稳定 ID 集合比较，协办换序
  作为 no-op，主负责人变化仍是有效调整。

## 6. 第五至第八轮 safe-share 聚焦复审

### 6.1 第五轮

- **ME5-NEW-001 / P1**：跨类型同值 ID 在无类型引用中的语义未闭环。
- **ME5-NEW-002 / P2**：pending action 原子处理未覆盖完整时序。
- **ME5-NEW-003 / P2**：动态测试和变异强度不足。

这些中间问题推动无类型引用采用 fail-closed 语义，并补充真实 Stage A crash-window、
pending player/agent 原子规范化及集中式 Reference Contract；均不再作为最终开放问题。

### 6.2 第六轮

第六轮曾因以下问题暂缓提交：

- **ME6-NEW-001 / P1**：无类型 `sourceIds` / `relatedEntityIds` 的歧义安全语义未确定。
- **ME6-NEW-002 / P1**：Stage A 后、turn 写入前的 `pendingAgentAction` 可能泄漏。
- **ME6-NEW-003 / P2**：private current agenda 删除后，`pendingPlayerAction` 可能形成孤儿状态。

最终产品语义为：无类型或多态 raw ID 仅在字段允许的实体类型中可唯一解析，且唯一目标明确公开时保留；
歧义、unknown、private 或无法证明公开的引用一律 fail-closed。

### 6.3 第七轮

- **ME7-NEW-001 / P0**：历史 session version 错误使用当前 agenda visibility，形成时间线 TOCTOU。
- **ME7-NEW-002 / P1**：missing/deleted agenda fail-open。
- **ME7-NEW-003 / P1**：未登记的公开或 unknown structured raw ID 静默通过。
- **ME7-NEW-004 / P2**：正式测试未调用真实 Stage A 生产路径。
- **ME7-NEW-005 / P2**：字段允许类型缺少集中、可执行的领域契约。

对应修正采用 version-local visibility、rollback ancestry-aware resolution、
missing/deleted/ambiguous fail-closed、真实 Stage A crash-window，以及集中式 Reference Contract。

### 6.4 第八轮

- **ME8-NEW-001 / P1**：current session 引用数组的清理结果未原子写回。
- **ME8-NEW-002 / P1**：agenda version 与 session/meeting/version/timeline 关系错配未 fail-closed。
- **ME8-NEW-003 / P1**：已登记 typed unknown ID 仍可能静默通过。
- **ME8-NEW-004 / P2**：全局字段名 contract 和 non-entity exception 的作用域过宽。

后续统一 current/history 字段转换，对 agenda/session/version 关系执行严格 fail-closed；
Reference Contract 改为按对象、表和 JSON path 限定上下文。未来字段登记与维护成本保留为非阻断 backlog。

## 7. 第九轮固定矩阵与第十轮单问题收口

第九轮固定矩阵确认 **ME8-NEW-001**、**ME8-NEW-002** 和 **ME8-NEW-004** 的当前可达风险已关闭；
**ME8-NEW-003** 当时仍开放。该轮唯一新确认的 P1 为：`GameState.meetings[*].participantIds` 中
registered typed unknown character ID 可穿透 safe-share、SQLite、import/reopen 和 second export。

第十轮定位到两个根因：GameState sanitizer 漏处理 `meetings[*].participantIds`，且 snapshot/final
validator 漏查 registered typed unknown character。最终修正为：

- `participantIds` 使用 meeting/character typed Reference Contract，仅保留 known public character；
- unknown character fail-closed，过滤结果原子写回克隆 meeting；
- final snapshot/reference validation 同时检查 known registry；
- SQLite、ZIP、import、reopen 与 second export 均不会恢复 unknown character。

独立复审覆盖 known public、mixed public/unknown、unknown-only、双向跨类型同值碰撞；当前生产 schema
没有 known private character 的对应建模，合成 unsafe/fail-closed 条件已验证。成功与拒绝路径均保持源状态不变，
Mutation A–D 均被正式测试捕获。最终结论：`participantIds` registered typed unknown P1 已关闭。

## 8. 最终 Reference Contract 与问题状态

safe-share 使用集中、可执行且带上下文的 Reference Contract 处理 typed、polymorphic 与 raw ID：
只有唯一解析到明确公开目标的引用可以保留，其余情况 fail-closed。版本化 session/agenda 查询使用各自 revision
上的可见性和回滚祖先链，不使用当前投影替代历史事实。

Phase 5 safe-share 修复已经收口，所有已确认 P0/P1 均已关闭。Reference Contract 对未来新增字段、表和 JSON path
的登记维护属于非阻断 backlog，不构成当前提交准备阻断。

## 9. 正式支持范围门禁

Node v25.2.1 的早期结果仅作为辅助证据，不作为正式支持环境验收。正式门禁使用：

```text
Node binary: D:\Users\Admin0\Documents\@work\tools\node-v24.18.0-win-x64\node.exe
Node: v24.18.0
npm: 11.16.0
```

Node v24.18.0 满足 `package.json` 声明的 `>=24.15.0 <25` 支持范围，因此本轮结果构成项目正式支持运行时下的完整门禁证据。

PATH、`where node`、`process.execPath`、`npm_node_execpath` 与 npm lifecycle 子进程均指向该运行时；
`EBADENGINE = 0`。验证全程 offline，未安装或下载依赖。诊断期间一次 `npm exec` package resolution
在 offline cache 层返回 `ENOTCACHED`，未形成网络访问，也不属于正式门禁失败。

正式结果：

- participant focused：5/5，连续三轮通过；
- safe-share：49/49，连续三轮通过；
- `npm test`：59 files / 534 tests；
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run check:data`、
  `npm run check:phase2`、`npm run check:phase3`、`npm run check:phase4`、`npm run check:phase5`、
  `npm run check:review-fixes`、`npm run format:check` 与 `git diff --check` 均为 exit code 0。

## 10. 最终提交准备状态

最终提交准备审查覆盖 65 个 Phase 5/review-fixes 变化文件：49 个 tracked modified 与 16 个 untracked，
staged 为 0；tracked diff 为 3,776 additions / 452 deletions。16 个 untracked 包括：

- 1 个必需生产文件：`packages/save-system/src/timeline.ts`；
- 12 个必需回归测试，共覆盖 91 tests；
- 3 个项目文档。

最终提交准备审查推荐将这 65 个 Phase 5 文件作为单一提交纳入，以保持生产代码、`timeline.ts`、回归测试、review scripts 与项目文档之间的依赖完整性和门禁可复现性；这只是提交结构推荐，尚未执行任何 stage、commit、push、PR 或 merge，所有 Git 操作仍需用户明确授权。

meeting/policy repository 与 service 依赖 `timeline.ts`；`package.json` review scripts 依赖全部 12 个
untracked tests；AGENTS、README 与 roadmap 引用本文档。建议排除文件和需要用户二选一决定的文件均为 0。
扫描未发现 Phase 6 文件、真实 secret、本机路径泄漏或 mutation/probe 临时产物。上文 Node binary 路径仅记录
本地门禁证据，不是项目硬编码运行时配置。

当前分支为 `phase5/policy-engine`，HEAD 为 `610c48d45d4f4ce187473b608bc8c06d198dd826`。
尚无 commit、push、PR、merge、reset、stash、clean、restore 或 checkout；任何 Git 发布操作仍需用户明确授权。
当前代码和测试已进入最终提交准备状态，后续只进行本文档的独立只读一致性复核，再等待 stage/commit 授权。
Phase 6 继续冻结。
