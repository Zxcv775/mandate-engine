# 会话记录 · 2026-07-26 · Phase 0 项目立项与架构基线

> 本目录（docs/progress/）按日期归档会话记录，供重开会话或更换智能体时恢复上下文。
> 常驻引导见根目录 `AGENTS.md`。

## 1. 会话概况

- 执行时间：2026-07-26
- 任务来源：用户提供的《阶段一提示词：项目立项与架构基线》（Phase 0）
- 执行方式：先 plan 模式勘察与出计划，用户批准后 build 模式执行
- 结果：**Phase 0 全部交付物完成，验收命令全绿，代码已推送 GitHub**

## 2. 环境检查结论

- 工作目录 `D:\Users\Admin0\Documents\@work` 是含多个不相关项目（AIRP、VPS、clear、@C# 等）的综合工作区；
- **无本项目相关既有代码**，零冲突、零迁移负担；
- 工具链：Node.js v25.2.1、npm 11.6.2、git 2.55.0；pnpm 未安装（→ npm workspaces）。

## 3. 用户做出的关键决策

| #   | 问题          | 决策                                                            |
| --- | ------------- | --------------------------------------------------------------- |
| 1   | 项目位置      | 新建 `@work/mandate-engine/` 独立子目录                         |
| 2   | 技术栈        | TypeScript 全栈（而非 Python 后端）                             |
| 3   | 存储方案      | SQLite（node:sqlite 内置；薄仓储层隔离，可替换 better-sqlite3） |
| 4   | GitHub 可见性 | Private（账号 Zxcv775）                                         |

## 4. 完成的工作

1. 目录骨架：`apps/ packages/ docs/ data/ scripts/ tests/ config/` 全部就位；
2. 文档 6 份：`docs/00` 愿景、`01` 需求（46 条可测试需求 + MVP 冻结 + 冲突记录）、
   `02` 架构（Mermaid 上下文/模块/调用链 + 会议规则环境表）、`03` 领域模型（26 实体）、
   `04` 技术选型（15 项）、`05` 路线图（Phase 0–10）；
3. ADR 5 份：模块化单体 / LLM-规则边界 / 数据驱动 / 历史数据分离 / LLM 供应商抽象；
4. 质量文件：README、CONTRIBUTING（7 条红线）、LICENSE（保留权利占位）、
   .editorconfig、.gitignore、.env.example、Prettier / ESLint 9 flat 配置；
5. 代码：`packages/shared`（Result / SeededRng / newId）、`packages/domain`
   （26 实体类型 + Zod Schema + 三种会议默认规则参数）、`packages/llm-adapters`
   （LLMProvider 接口 + MockLLMProvider + OpenAiCompatibleProvider(fetch) + 上下文裁剪）、
   6 个引擎包占位、`apps/server`（Fastify 健康检查）、`apps/web`（React + Zustand 最小页）；
6. 数据：`data/` 8 个 JSON 占位（明朝朝代、崇祯初政剧本、魏忠贤人物卡、6 个明代机构、
   陕西旱灾事件示例、欠饷规则示例、世界观条目、3 条史料来源），全部带
   `meta.sourceIds` + `confirmation` 标注；
7. 测试：19 个 Vitest 用例（Schema 校验、会议规则环境、种子随机复现、
   Mock 结构化输出重试三路径、上下文裁剪）；
8. git init + 首次提交 + 推送 GitHub。

## 5. 验证结果（实跑证据）

| 命令                 | 结果                                              |
| -------------------- | ------------------------------------------------- |
| `npm install`        | ✅ 281 包，0 vulnerabilities                      |
| `npm run lint`       | ✅ 0 错误                                         |
| `npm run typecheck`  | ✅ 13 个 workspace 全过                           |
| `npm test`           | ✅ 19/19 通过                                     |
| `npm run build`      | ✅ server 编译验证 + web 产物（gzip 61.6 KB）     |
| `npm run check:data` | ✅ data/ 全部 JSON 通过                           |
| 冒烟测试             | ✅ `/api/health` 返回 `{"status":"ok","phase":0}` |

## 6. 遇到的问题与修复（复用经验）

| 问题                                                                  | 修复                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ESLint 报 .mjs 脚本 `no-undef`（console/process/URL）                 | eslint.config.js 为 `**/*.mjs`、`**/*.js` 增加 Node globals                     |
| `LLMProviderError.cause` 触发 TS4114（noImplicitOverride）            | 移除重复声明，改用 Error 自带 `cause` 字段                                      |
| vite 双主版本（web=vite6，vitest 链=vite7）导致 plugin-react 类型冲突 | web 升级 vite ^7 + @vitejs/plugin-react ^5，全树统一 vite 7.3.6；已同步 docs/04 |
| npm audit 5 个高危（eslint 链 brace-expansion ≤5.0.7）                | 根 package.json `overrides: { "brace-expansion": "^5.0.8" }`，归零              |
| npm install 后残留 invalid 依赖                                       | 删 node_modules + package-lock.json 重装后正常                                  |

## 7. Git / GitHub 状态

- 仓库：https://github.com/Zxcv775/mandate-engine （PRIVATE）
- 分支：`main`（本地跟踪 `origin/main`）
- 提交：`9aa40f5 chore: 初始化项目（Phase 0：项目立项与架构基线）`（88 文件，8103 行）
- 本文件与 `AGENTS.md` 为后续增补，提交状态见最新 git log。

## 8. 待评审事项（未阻塞，见 docs/01 §4 与 docs/04）

1. **CONFLICT-001**：游戏内日期存公历 ISO 字符串，农历仅显示层换算（换算库 Phase 3 评估）；
2. **CONFLICT-002**：`node:sqlite` 在 Node 25 仍为 experimental 稳定性——薄仓储层隔离；
3. **LICENSE**：当前"保留所有权利"占位，正式协议待定（候选 MIT / AGPL-3.0）；
4. 会议规则参数初值为设计占位（gameplay-adjusted），Phase 9 统一平衡；
5. 崇祯即位公历日期（1627-10-02）的农历换算已标注"Phase 7 复核"。

## 9. 下一步（Phase 1 · 基础项目骨架）

仅四项（详见 docs/05-roadmap.md Phase 1）：

1. 服务端配置模块完善（dotenv+Zod 全量 env）与 LLMProvider 工厂（按 env 装配 Mock / OpenAI 兼容）；
2. 前后端联调定型（健康检查 + 统一错误格式）；
3. npm scripts 与开发体验完善；
4. 对应单测。

**Phase 1 未开始，等待用户评审确认。**
