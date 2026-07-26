# 04 · 技术选型记录

选型总原则：成熟、文档完整、适合单人/小团队；不为展示复杂度引入基础设施。
每项记录：选择结果 / 选择理由 / 替代方案 / 主要风险 / 未来替换成本。

## 总表

| 方面                      | 选择                                   | 替代方案                                 |
| ------------------------- | -------------------------------------- | ---------------------------------------- |
| 编程语言                  | TypeScript 5（strict，ESM）            | JavaScript、Python                       |
| 前端框架                  | React 19 + Vite 7                      | Vue、Svelte                              |
| 前端状态管理              | Zustand                                | Redux Toolkit、Jotai                     |
| 后端框架                  | Fastify 5                              | Hono、Express、NestJS                    |
| 数据库                    | SQLite（node:sqlite 内置）             | better-sqlite3、PostgreSQL、纯 JSON 文件 |
| ORM/数据访问              | 薄仓储层（无 ORM）                     | Drizzle、Prisma                          |
| Schema 校验               | Zod                                    | TypeBox、Valibot                         |
| 测试框架                  | Vitest                                 | Jest、node:test                          |
| LLM SDK                   | 自研薄接口 + 内置 fetch（OpenAI 兼容） | openai SDK、Vercel AI SDK                |
| 日志                      | pino                                   | winston、console                         |
| 配置管理                  | dotenv + Zod 校验                      | convict、手写 process.env                |
| Monorepo                  | npm 11 workspaces                      | pnpm、Turborepo、Nx                      |
| 代码质量                  | ESLint 9（flat）+ Prettier             | Biome、oxlint                            |
| TS 运行器（开发期服务端） | tsx                                    | ts-node、--experimental-strip-types      |
| 形态                      | 网页版优先（预留 Tauri）               | Electron、纯 CLI                         |

## 逐项说明

### 1. 编程语言：TypeScript 5（strict）

- 理由：前后端单语言；领域模型与 Zod Schema 类型贯通；strict 保证可维护性；
  LLM 生态（OpenAI 兼容端点 + fetch）在 Node 上无障碍。
- 替代：Python（LLM 生态更强，但前后端双语言、类型无法共享，小团队成本高）。
- 风险：构建链路比纯 JS 多一层。
- 替换成本：高（全仓代码），属基石决策，不轻易更换。

### 2. 前端框架：React 19 + Vite 7

- 理由：生态最大、文档最全、招聘/维护最容易；Vite 开发体验好、对 monorepo 友好；
  vite 主版本与 vitest 依赖对齐（避免双主版本并存导致的类型冲突）。
- 替代：Vue（同样优秀，生态略小）、Svelte（更小众）。
- 风险：React 19 部分三方库适配滞后（本项目依赖极少，风险低）。
- 替换成本：中（UI 集中在 apps/web 与 packages/ui）。

### 3. 前端状态管理：Zustand

- 理由：轻量（~1KB）、无模板代码、与 React 19 兼容好；游戏 UI 状态不复杂。
- 替代：Redux Toolkit（过重）、Jotai（原子化收益对本项目不明显）。
- 风险：低。替换成本：低。

### 4. 后端框架：Fastify 5

- 理由：成熟、性能充足、TS 支持好、内置 pino 日志、插件生态完善。
- 替代：Hono（更新更轻但生态略浅）、Express（老旧）、NestJS（过重）。
- 风险：低。替换成本：中（应用服务层薄，路由集中）。

### 5. 数据库：SQLite（node:sqlite 内置模块）

- 理由：单机单人游戏无需数据库服务器；Node ≥22.5 内置 `node:sqlite`，零依赖；
  适合存档快照 + 变更日志的读写模式；SQL 便于按回合查询日志。
- 替代：better-sqlite3（原生模块，需编译链）、PostgreSQL（运维过重）、纯 JSON 文件（查询弱）。
- 风险：Phase 2 仍需以固定 Node 24 基线验证 `node:sqlite` API 与存档迁移；游戏状态嵌套深，
  快照将整体序列化为 JSON 存储，规避关系建模成本。
- 替换成本：低——数据访问集中在薄仓储层，可整体换成 better-sqlite3/Drizzle。

### 6. 数据访问：薄仓储层（暂不引入 ORM）

- 理由：两张表（saves / state_change_log）+ JSON 快照，ORM 收益为零；
  Zod 已负责结构校验。
- 替代：Drizzle（表结构复杂化后再评估）、Prisma（重）。
- 风险：未来表增多需重构。替换成本：低（仓储接口隔离）。

### 7. Schema 校验：Zod

- 理由：TS 生态事实标准；DTO、LLM 结构化输出、存档、配置四处复用同一套 Schema。
- 替代：TypeBox（JSON Schema 友好）、Valibot（更轻）。
- 风险：低。替换成本：中（Schema 分布广，但概念可一一映射）。

### 8. 测试框架：Vitest

- 理由：TS 原生、与 Vite 同生态、快；测试不得依赖真实 LLM（FR-TEST-001）。
- 替代：Jest（配置重）、node:test（断言/快照生态弱）。
- 风险：低。替换成本：低。

### 9. LLM SDK：自研 LLMProvider 薄接口 + 内置 fetch

- 理由：业务代码不依赖任何厂商（ADR-005）；OpenAI 兼容端点只需 HTTP POST，
  Node 内置 fetch 足够；Mock 供应商保证离线测试；避免 Vercel AI SDK 的抽象锁定。
- 替代：openai 官方 SDK（可在需要高级特性时引入到适配器内部）、Vercel AI SDK。
- 风险：需自维护重试/超时逻辑（代码量小，已含指数退避）。
- 替换成本：低（接口隔离；内部实现可换 SDK）。

### 10. 日志：pino

- 理由：Fastify 内置集成、结构化 JSON、性能最好之一。
- 替代：winston（较慢）、console（无结构）。
- 风险：低。替换成本：低。

### 11. 配置管理：dotenv + Zod

- 理由：`.env` 本地开发足够；Zod 校验在启动时失败即报错，避免运行期诡异行为。
- 替代：convict、手写 process.env（无校验）。
- 风险：低。替换成本：低。

### 12. Monorepo：npm 11 workspaces

- 理由：Node 24 LTS 与 npm 11 固定版本；满足 apps/* 与 packages/* 划分。
- 替代：pnpm（更省磁盘，需额外安装）、Turborepo/Nx（当前规模无收益）。
- 风险：依赖提升导致的版本冲突（当前依赖少，可控）。
- 替换成本：中（可平滑迁往 pnpm）。

### 13. 代码质量：ESLint 9 flat config + Prettier

- 理由：最成熟；flat config 是现行标准；Prettier 只管格式，ESLint 只管质量，互不越界。
- 替代：Biome（快但规则覆盖少）、oxlint（早期）。
- 风险：低。替换成本：低。

### 14. 开发期 TS 运行器：tsx

- 理由：服务端开发直接运行 TS，watch 重启快；无构建等待。
- 替代：node --experimental-strip-types（类型擦除限制多）、ts-node（慢）。
- 风险：低。替换成本：低。生产打包方案在 Phase 8 前评审（tsup/直接发布 TS + tsx）。

### 15. 形态：网页版优先，预留 Tauri

- 理由：浏览器即客户端，开发迭代最快；Tauri 可在未来打包桌面版且复用全部前端。
- 替代：Electron（体积大）、纯 CLI（体验差）。
- 风险：SSE 流式在桌面 webview 的兼容性（Phase 4 验证）。
- 替换成本：低（前端与后端本就分离）。

## 版本基线（Phase 2 固定）

| 依赖                   | 版本范围                                                 |
| ---------------------- | -------------------------------------------------------- |
| node                   | 24.18.0（`.nvmrc`；Phase 2 的 node:sqlite 基线）         |
| npm                    | 11.16.0（`packageManager`）                              |
| typescript             | ^5.5                                                     |
| react / react-dom      | ^19                                                      |
| vite                   | ^7（与 vitest 的 vite 主版本对齐，避免双主版本类型冲突） |
| @vitejs/plugin-react   | ^5                                                       |
| zustand                | ^5                                                       |
| fastify                | ^5                                                       |
| zod                    | ^4                                                       |
| tsx                    | ^4                                                       |
| vitest                 | ^3                                                       |
| eslint / @eslint/js    | ^9                                                       |
| typescript-eslint      | ^8                                                       |
| eslint-config-prettier | ^9.1                                                     |
| prettier               | ^3                                                       |
| dotenv                 | ^16.4                                                    |
| @types/node            | ^24                                                      |
| fflate                 | ^0.8（`.mesave` ZIP 容器；无原生依赖）                   |

## Phase 1 的最小工具选择

- **Data Loader 独立 workspace**：校验脚本、Server 和测试都会复用，独立包能消除 Schema 分叉；
- **Provider Factory 留在 Server**：它是应用配置到适配器的装配点，不属于通用 LLM 接口；
- **原生 fetch API Client**：只需要超时、取消、Envelope 和 Zod，未引入请求框架；
- **简单 Prompt Renderer**：固定注册表 + `{{name}}` 足以覆盖当前资产测试，未引入模板 DSL；
- **concurrently**：只解决一条命令启动两个开发进程，不引入任务编排平台；
- **GitHub Actions 单 Job**：当前规模无需版本矩阵、容器或远程服务。

## Phase 2 的最小工具选择

- **`node:sqlite` + 薄 Repository**：Node 24.18.0 实测具备 `DatabaseSync`、`createSession`、
  `applyChangeset`、`backup`、`serialize`、`deserialize`；本阶段使用 DatabaseSync/Backup，未为了未使用能力
  引入第三方驱动。同步 API 适合当前单机规模，性能数据单独记录。
- **STRICT SQLite + JSON snapshot**：关系表管理事务、索引和 hash chain；GameState JSON 仍由 Domain Zod
  验证，避免把每个未来玩法字段过早拆成 SQL 列。
- **snapshot + StateChangeLog**：支持按 revision replay、审计、logical rollback 与分叉识别；未引入事件溯源框架。
- **`fflate`**：只负责固定白名单 ZIP 条目，体积小、纯 JavaScript；manifest/checksum/SQLite 校验仍由本项目实现。
- **Node `crypto`**：SHA-256、AES-256-GCM 与 scrypt 均使用内置模块，不增加加密 SDK。
- **原生 fetch + Zustand 延续**：Save Browser 复用 Phase 1 Client/Store，不引入 React Query 或 UI 组件库。
- **前向迁移**：数据库与状态 migration registry 自研为小型白名单列表；未引入 ORM 或通用 migration 平台。
- **CLI 复用 Service**：`save:*` 命令只做参数/IO 适配，不复制 Repository、回滚、导入导出或校验逻辑。

相关不可逆决策见 ADR-006（SQLite）、ADR-007（日志/回滚）、ADR-008（迁移/分叉）与
ADR-009（确定性引擎）。

### 14. 人物记忆检索：确定性规则评分（Phase 3，暂不引入向量数据库）

- 决策：记忆选择使用 topic/entity/importance/confidence/recency 规则评分 + 预算截断，
  同分按 memoryId 字典序，完全确定性；不引入向量数据库、Embedding 服务或 RAG 框架。
- 理由：Phase 3 记忆量级（百千条）下规则评分可复现、可离线 CI、零新依赖；
  向量检索的收益要到记忆规模与语义多样性显著增长后才体现。
- 升级路径：ADR-012 预留——若后续需要语义检索，将以"候选粗排（向量）+ 规则精排"方式
  叠加，不替换现有确定性层。

### 15. Prompt 组合：注册表 + Manifest + Composer（Phase 3）

- 决策：Prompt 一律为版本化 Markdown 资产 + 白名单注册表 + Manifest 元数据；
  组合由 `composeCharacterPrompt` 按固定九段顺序完成，简单 `{{var}}` 替换，不引入模板 DSL。
- 理由：可代码审查、可 Snapshot 回归、注入面最小；数据与指令用分隔标签 + 全角转义隔离。
