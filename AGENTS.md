# AGENTS.md —— 智能体引导文件

> 本文件面向一切参与本项目开发的 AI 智能体与人类协作者。
> 新会话/新智能体请先读本文件，再按"文档阅读顺序"深入。

## 1. 项目一句话

**天命：帝国推演（Mandate Engine）**——LLM 驱动的中国历史皇帝模拟游戏。
**LLM 扮演人物、生成语言；规则引擎计算国家、结算后果。** 首个剧本：明末崇祯初政。

## 2. 当前状态（2026-07-26 更新）

- **Phase 0（项目立项与架构基线）已完成并验收**：文档全套、目录骨架、最小可运行代码、19 个测试全绿。
- **Phase 1（基础项目骨架）尚未开始**，等待评审确认后启动（任务见 `docs/05-roadmap.md`）。
- 仓库：<https://github.com/Zxcv775/mandate-engine>（PRIVATE，默认分支 main）。
- 会话记录：`docs/progress/`（按日期归档，重开会话先读最新一份）。

## 3. 快速上手

```bash
npm install          # Node ≥ 22.5（开发用 25.x），无需任何 API Key
npm run dev:server   # 后端 Fastify @127.0.0.1:3000
npm run dev:web      # 前端 Vite（/api 代理到后端）
npm run lint         # ESLint
npm run typecheck    # 全 workspace tsc --noEmit
npm test             # Vitest（禁止触网，用 MockLLMProvider）
npm run build        # web 产物 + 其余包编译验证
npm run check:data   # data/ JSON 校验
```

提交前以上命令必须全部通过。

## 4. 目录速览

```text
apps/web · apps/server          # 前端 / 后端
packages/domain                 # 领域模型代码（docs/03 的实现，26 实体 + Zod Schema + 会议规则参数）
packages/shared                 # Result / SeededRng / newId
packages/llm-adapters           # LLMProvider 接口 + Mock + OpenAI 兼容（fetch）
packages/game-engine|rule-engine|event-engine|agent-runtime|prompt-system|ui
                                # 占位包（按 docs/05 阶段逐步实现，勿提前写业务代码）
data/                           # 历史模板（只读！带 meta.sourceIds + confirmation 标注）
docs/                           # 00-05 核心文档 + adr/ + progress/
tests/                          # Vitest 跨包测试
```

## 5. 文档阅读顺序（深入前必读）

1. `docs/00-project-vision.md` —— 愿景、核心循环、非目标；
2. `docs/01-requirements.md` —— 需求与 **MVP 冻结范围**、冲突记录；
3. `docs/02-system-architecture.md` —— 架构图、回合调用链、责任边界；
4. `docs/03-domain-model.md` —— 实体定义与 LLM 可写白名单；
5. `docs/adr/ADR-001~005` —— 五个不可推翻的架构决策；
6. `docs/05-roadmap.md` —— 当前阶段的任务、验收标准与排除项。

## 6. 红线（违反 = 返工）

1. LLM 不碰数值；规则引擎是唯一数值结算方（ADR-002）；
2. 状态写入只有一个入口（状态引擎）；Agent/UI 不得直接改状态；
3. `data/` 历史模板运行时只读；新增模板必须带史料来源与四类确认标注；
4. 禁止 `eval` / `new Function`；条件逻辑走白名单 DSL（ADR-003）；
5. 核心引擎包（game/rule/event-engine）禁止依赖 llm-adapters / agent-runtime；
6. 随机一律用 `SeededRng`（禁止 `Math.random()`），测试必须固定种子；
7. 测试禁止触网：LLM 一律用 `MockLLMProvider`。

## 7. 关键决策（已定，勿推翻；变更须先写 ADR）

| 决策 | 结论 | 出处 |
|---|---|---|
| 架构风格 | 模块化单体 + 前后端分离 | ADR-001 |
| LLM/规则边界 | 规则优先叙事后置，LLM 无写权限 | ADR-002 |
| 规则表达 | Modifier + 条件 DSL（数据驱动） | ADR-003 |
| 数据分层 | 模板=data/ 只读；状态=SQLite(node:sqlite) | ADR-004 |
| LLM 供应商 | LLMProvider 接口；Mock + OpenAI 兼容 fetch | ADR-005 |
| 技术栈 | TypeScript 全栈、React+Vite、Fastify、Zod、Vitest | docs/04 |
| 项目位置 | `@work/mandate-engine/` 独立目录（用户决策 1） | progress |
| 存储 | node:sqlite（用户决策 3，薄仓储隔离可替换） | docs/04 |

## 8. 协作约定

- 文档中文、代码标识符英文、关键注释中文；
- 提交信息：`<scope>: <中文简述>`；
- **不自动进入下一阶段**：每阶段完成需人工评审；
- **git 突变（commit/push 等）必须每次征得用户确认**；
- 架构级变更：先 ADR 后代码；改了已冻结设计须同步更新 docs；
- 每完成一个阶段/重要会话，在 `docs/progress/` 追加一份日期归档记录，并更新本文件第 2 节。
