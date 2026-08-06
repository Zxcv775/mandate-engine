# 天命：帝国推演（Mandate Engine）

> LLM 驱动的中国历史政治模拟游戏。
> **LLM 扮演人物、生成语言；规则与状态引擎计算事实、数值和后果。**

首个剧本为明末 **崇祯初政**。当前已完成 Phase 5：在会议编排（Phase 4）之上，新增数据驱动
规则引擎（受限条件树 + 八种白名单 effect，禁 eval）、统一 Modifier 系统
（可叠加/可过期/可审计）、政策完整生命周期（提出 → 御批 → 颁行 → 逐 tick 执行结算 →
奏报回馈；11 态状态机 + 8 个白名单命令）、确定性执行偏差（拖延/表面完成/数字造假/
层层加码/选择性执行/腐败损耗）与奏报-真实分离（玩家读奏报，真实值在 hidden 仅 Debug）、
9 个崇祯初政政策模板（史料标注），以及 Policy Lab 调试台。会议候选可映射为
policy.propose——御前"准行"即立案。

## 环境要求

- Node.js `24.18.0`（`.nvmrc`）
- npm `11.16.0`（`package.json#packageManager`）

```bash
npm ci
```

默认不需要 API Key，也不会访问外部 LLM。

## 配置

复制 `.env.example` 为 `.env`。离线开发配置：

```env
NODE_ENV=development
LLM_PROVIDER=mock
LLM_MODEL=mock-model
DEFAULT_SCENARIO_ID=chongzhen-early
SAVE_DATABASE_PATH=./saves/mandate-engine.sqlite
SAVE_CHECKPOINT_INTERVAL=50
```

OpenAI-compatible 端点只有在显式配置时启用；Base URL 与模型必填，API Key 可选以兼容本地无鉴权端点。
配置在监听端口前经 Zod 校验，公开 API/日志只返回安全摘要。

## 启动与联调

```bash
npm run dev          # 同时启动 Server 与 Web
npm run dev:server   # Fastify：http://127.0.0.1:3000
npm run dev:web      # Vite，/api 代理到 Server
```

Runtime Dashboard 展示服务、版本/Phase、Provider、默认场景和刷新状态；Phase 2 Save Browser 额外展示：

- 存档标题、场景、日期、head revision、snapshot 数量与 source metadata mode；
- GameState 国家摘要、tick、人物/政策/会议数量与 RNG cursor；
- StateChangeLog revision、tx、command、actor、aggregate/entity、before/after 摘要与 visibility；
- revision、commandType、actorType、aggregateType、entityId 过滤。

普通页面不显示 hidden、sealed、API Key、Authorization 或完整 Prompt。

## 存档 API

所有接口使用 `{ ok, data|error, meta: { requestId } }`：

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

`GET .../state` 返回 PlayerStateView，不含 hidden；`GET .../changes` 不含 sealed 日志。

## 人物 API（Phase 3）

```text
GET  /api/saves/:saveId/characters                          # 运行时人物摘要
GET  /api/saves/:saveId/characters/:characterId             # 公开档案
POST /api/saves/:saveId/characters/:characterId/respond     # 单人物召对（公开投影）
GET  /api/debug/saves/:saveId/characters/:characterId/context   # Debug：知识视图摘要
GET  /api/debug/saves/:saveId/characters/:characterId/memories  # Debug：记忆查询
POST /api/debug/saves/:saveId/characters/:characterId/respond   # Debug：带调试信息召对
```

respond 不提交任何 GameState 变更；Debug API 生产环境默认 404（`DEBUG_API_ENABLED` 可覆盖）。
Web 端 Character Lab 页签提供存档/人物/场合选择与结构化响应展示。

## 存档 CLI

CLI 与 HTTP API 共用 `GameStateService`：

```bash
npm run save:check -- --save ./saves/mandate-engine.sqlite --json
npm run save:repair -- --database ./saves/mandate-engine.sqlite --save <save-id> --dry-run
npm run save:rollback -- --database ./saves/mandate-engine.sqlite --save <save-id> --target-revision 37 --dry-run
npm run save:export -- --database ./saves/mandate-engine.sqlite --save <save-id> --out ./tmp/demo.mesave
npm run save:import -- --database ./saves/imported.sqlite --file ./tmp/demo.mesave
npm run save:migrate -- --database ./saves/mandate-engine.sqlite --save <save-id>
```

导出包固定包含 manifest、SQLite payload 和 checksums；可选口令加密、剥离 source catalog 与 safe-share。
分叉导入默认创建独立 save，不覆盖任何世界线。

## 测试与质量门

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:data
npm run check:saves
npm run test:migrations
npm run test:rollback
npm run test:integrity
npm run test:determinism
npm run check:phase2
npm run check:characters
npm run test:character-views
npm run test:character-memory
npm run test:character-security
npm run test:prompt-assets
npm run check:phase3
npm run check:phase4
npm run check:phase5
npm run check:review-fixes
```

`check:phase5` 串行覆盖 Phase 2–5 全部门禁；`check:review-fixes` 聚合回滚投影、会议原子性、
幂等竞态、Agent 陈旧响应、导入安全、政策成本与 safe-share 的审查专项回归。
CI 使用 Mock Provider 与临时 SQLite，不需要 Secrets，也不写开发存档。
性能基准可通过 `npm run benchmark:phase2` / `npm run benchmark:phase3` 复现，报告位于 `docs/progress/`。

## 目录结构

```text
apps/server                 # Fastify 装配、统一错误/Envelope、Save/Character/Meeting/Policy API
apps/web                    # Runtime Dashboard、Save Browser、Character/Meeting/Policy Lab
packages/domain             # 历史模板 + GameState/Command/Save + 人物/会议/政策/规则契约
packages/game-engine        # 纯状态引擎、RNG/Clock、stable hash、initial state
packages/save-system        # SQLite、共享事务、时间线投影、导入导出、人物/会议/政策仓储
packages/data-loader        # 只读历史模板校验、引用检查、ScenarioBundle
packages/llm-adapters       # Mock / OpenAI-compatible Provider
packages/prompt-system      # 注册式版本化 Prompt 资产 + manifest + composer + budget
packages/agent-runtime      # 知识视图、记忆策略/选择器、Context Builder、Character Agent
packages/meeting-engine     # 会议状态机、调度、Director、候选映射与泄密评估
packages/rule-engine        # 白名单 DSL、Modifier、政策生命周期与确定性结算
data                        # 只读历史模板
scripts                     # data/save CLI、临时存档校验与 benchmark
tests                       # 单元、Repository、事务、API、CLI、安全与集成测试
```

## 核心原则

1. `data/` 是只读历史模板；运行事实只进入 GameState/SQLite。
2. StateEngine/GameStateService 是唯一写入口；Route、React、LLM、Prompt 不直接改状态。
3. Command 白名单 + baseRevision + idempotency，Mutation 先计划、后校验、再原子提交。
4. seed/cursor 和 Clock 可注入；核心引擎禁止 `Math.random()`。
5. StateChangeLog 与回滚事件追加式保留；当前态查询按回滚时间线投影，不删除旧审计历史。
6. API、日志、存档和导出不持久化原始凭据；普通 View 剥离 hidden/sealed。

7. 角色只见其身份允许的信息：知识视图六级可见性 + 认知标注；Agent 不读完整 GameState。
8. LLM 输出只是建议：结构化契约 + 受控修复 + 确定性一致性检查；候选行动不会自动执行。

详细设计见 `docs/02-system-architecture.md`、`docs/03-domain-model.md`、
`docs/06-phase-2-implementation.md` 至 `docs/10-review-fixes.md` 与 ADR-006~026。

## 当前边界与下一阶段

Phase 5 已完成会议与政策闭环；Phase 6 尚未开始。当前仍未实现完整事件链、奏折生成管线、
向量数据库/RAG、云存档或正式游戏 UI。下一阶段范围以 `docs/05-roadmap.md` 为准，不自动进入。

## 许可证

当前保留所有权利，正式许可证待定（见 `LICENSE`）。
