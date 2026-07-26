# 04 · 技术选型记录

选型总原则：成熟、文档完整、适合单人/小团队；不为展示复杂度引入基础设施。
每项记录：选择结果 / 选择理由 / 替代方案 / 主要风险 / 未来替换成本。

## 总表

| 方面 | 选择 | 替代方案 |
|---|---|---|
| 编程语言 | TypeScript 5（strict，ESM） | JavaScript、Python |
| 前端框架 | React 19 + Vite 7 | Vue、Svelte |
| 前端状态管理 | Zustand | Redux Toolkit、Jotai |
| 后端框架 | Fastify 5 | Hono、Express、NestJS |
| 数据库 | SQLite（node:sqlite 内置） | better-sqlite3、PostgreSQL、纯 JSON 文件 |
| ORM/数据访问 | 薄仓储层（无 ORM） | Drizzle、Prisma |
| Schema 校验 | Zod | TypeBox、Valibot |
| 测试框架 | Vitest | Jest、node:test |
| LLM SDK | 自研薄接口 + 内置 fetch（OpenAI 兼容） | openai SDK、Vercel AI SDK |
| 日志 | pino | winston、console |
| 配置管理 | dotenv + Zod 校验 | convict、手写 process.env |
| Monorepo | npm workspaces | pnpm、Turborepo、Nx |
| 代码质量 | ESLint 9（flat）+ Prettier | Biome、oxlint |
| TS 运行器（开发期服务端） | tsx | ts-node、--experimental-strip-types |
| 形态 | 网页版优先（预留 Tauri） | Electron、纯 CLI |

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
- 风险：**node:sqlite 在 Node 25 仍为 experimental 稳定性等级**，API 可能微调
  （已记录为 CONFLICT-002）；游戏状态嵌套深，快照整体序列化为 JSON 存储，规避关系建模成本。
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

### 12. Monorepo：npm workspaces

- 理由：Node 25 自带 npm 11，零安装；满足 apps/* 与 packages/* 划分。
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

## 版本基线（Phase 0 锁定）

| 依赖 | 版本范围 |
|---|---|
| node | ≥ 22.5（node:sqlite 基线），开发环境 25.x |
| typescript | ^5.5 |
| react / react-dom | ^19 |
| vite | ^7（与 vitest 的 vite 主版本对齐，避免双主版本类型冲突） |
| @vitejs/plugin-react | ^5 |
| zustand | ^5 |
| fastify | ^5 |
| zod | ^4 |
| tsx | ^4 |
| vitest | ^3 |
| eslint / @eslint/js | ^9 |
| typescript-eslint | ^8 |
| eslint-config-prettier | ^9.1 |
| prettier | ^3 |
| dotenv | ^16.4 |
| @types/node | ^24 |
