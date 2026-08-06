# AGENTS.md —— 智能体引导文件

> 本文件面向一切参与本项目开发的 AI 智能体与人类协作者。
> 新会话/新智能体请先读本文件，再按"文档阅读顺序"深入。

## 1. 项目一句话

**天命：帝国推演（Mandate Engine）**——LLM 驱动的中国历史皇帝模拟游戏。
**LLM 扮演人物、生成语言；规则引擎计算国家、结算后果。** 首个剧本：明末崇祯初政。

## 2. 当前状态（2026-07-28 更新）

- **Phase 0（项目立项与架构基线）已完成并验收**。
- **Phase 1（基础工程与前后端联调闭环）已完成并验收**：配置/Provider、统一 API、
  深度数据校验与只读 Loader、Runtime Dashboard、Prompt 最小资产、CI。
- **Phase 2（GameState、事务状态引擎与 SQLite 存档）已完成并验收**：确定性引擎、
  StateChangeLog、checkpoint/replay、逻辑回滚、迁移、校验、导入导出、Save API/CLI/Browser。
- **Phase 3（人物卡、知识视图、Prompt 资产与单人物 Character Agent）已完成并验收**：
  分层人物卡与首批 5 名人物、六级可见性知识视图、SQLite 人物记忆基础设施、
  23 个版本化 Prompt 资产 + Composer、结构化输出 + 受控修复 + 确定性一致性检查、
  人物 API 与 Character Lab；`check:phase3` 全绿（33 个测试文件）。见 ADR-010~014 与
  `docs/07-phase-3-implementation.md`。
- **Phase 4（会议编排与多人物议政）已完成并验收**：会议状态机、Meeting Director、
  确定性发言调度、两阶段 Agent 回合与崩溃恢复、Transcript、结果候选白名单裁决、
  会议纪要与分化记忆、泄密评估、会议 API 与 Meeting Lab；`check:phase4` 全绿。
  见 ADR-015~021 与 `docs/08-phase-4-implementation.md`。
- **Phase 5（规则引擎与政策执行）已完成并验收**：规则 DSL + 解释器、Modifier 系统、
  政策 11 态生命周期与 8 个白名单命令、time.advance 同事务执行结算（六类确定性偏差、
  奏报/真实分离）、migration 004、9 个政策模板、政策 API 与 Policy Lab；
  `check:phase5` 全绿。见 ADR-022~026 与 `docs/09-phase-5-implementation.md`。
- **Phase 2–5 代码审查修复已落地**：回滚时间线、会议事务、幂等竞态、Agent 陈旧响应、
  safe-share 传递引用、政策执行资格、裁决时间线幂等、ZIP 边界与政策成本账本；
  Migration 009 已将数据库版本提升至 9。见 `docs/10-review-fixes.md` 与
  `docs/progress/2026-07-28-fourth-round-fixes.md`。
- **Phase 6 尚未开始**；入口见 `docs/05-roadmap.md`，不得自动进入。
- 仓库：<https://github.com/Zxcv775/mandate-engine>（PRIVATE，默认分支 main）。
- 会话记录：`docs/progress/`（按日期归档，重开会话先读最新一份）。

## 3. 快速上手

```bash
npm ci               # Node 24.18.0 / npm 11.16.0，无需任何 API Key
npm run dev          # 并发启动前后端
npm run dev:server   # 后端 Fastify @127.0.0.1:3000
npm run dev:web      # 前端 Vite（/api 代理到后端）
npm run lint         # ESLint
npm run typecheck    # 全 workspace tsc --noEmit
npm test             # Vitest（禁止触网，用 MockLLMProvider）
npm run build        # web 产物 + 其余包编译验证
npm run check:data   # JSON + Domain Schema + 引用校验
npm run check        # 串行执行全部质量门
npm run check:saves  # 创建临时 SQLite 并验证完整存档闭环
npm run check:phase2 # Phase 2 全量阻断式质量门
npm run check:phase3 # Phase 2 门禁 + 人物/记忆/Prompt/安全测试
npm run check:phase4 # Phase 3 门禁 + 会议状态机/调度/恢复/安全/集成
npm run check:phase5 # Phase 4 门禁 + 规则/政策生命周期/安全/集成（当前全量门）
npm run check:review-fixes # 代码审查修复专项回归
```

提交前以上命令必须全部通过。

## 4. 目录速览

```text
apps/web · apps/server          # 前端 / 后端
packages/domain                 # 领域模型代码（docs/03 的实现，26 实体 + Zod Schema + 会议规则参数）
packages/shared                 # Result / SeededRng / newId
packages/llm-adapters           # LLMProvider 接口 + Mock + OpenAI 兼容（fetch）
packages/data-loader            # 历史模板深度校验 + 只读场景 Bundle + 缓存
packages/prompt-system          # 注册式版本化资产 + manifest + composer + budget（Phase 3）
packages/game-engine            # Phase 2 纯状态引擎、RNG/Clock、Mutation/hash
packages/save-system            # SQLite Repository、事务、迁移、回滚、导入导出、人物记忆仓储
packages/agent-runtime          # Phase 3 知识视图、记忆策略、Character Agent（无状态写入口）
packages/meeting-engine          # Phase 4 会议状态机/调度/Director/映射/泄密（零 LLM 依赖）
packages/rule-engine            # Phase 5 规则 DSL、Modifier、政策生命周期与结算
packages/event-engine|ui        # 按 docs/05 后续阶段实现，勿提前写业务代码
data/                           # 历史模板（只读！带 meta.sourceIds + confirmation 标注）
docs/                           # 00-06 核心文档 + adr/ + progress/
tests/                          # Vitest 跨包测试
```

## 5. 文档阅读顺序（深入前必读）

1. `docs/00-project-vision.md` —— 愿景、核心循环、非目标；
2. `docs/01-requirements.md` —— 需求与 **MVP 冻结范围**、冲突记录；
3. `docs/02-system-architecture.md` —— 架构图、回合调用链、责任边界；
4. `docs/03-domain-model.md` —— 实体定义与 LLM 可写白名单；
5. `docs/adr/ADR-001~026` —— 二十六个不可推翻的架构决策；
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

| 决策         | 结论                                                       | 出处     |
| ------------ | ---------------------------------------------------------- | -------- |
| 架构风格     | 模块化单体 + 前后端分离                                    | ADR-001  |
| LLM/规则边界 | 规则优先叙事后置，LLM 无写权限                             | ADR-002  |
| 规则表达     | Modifier + 条件 DSL（数据驱动）                            | ADR-003  |
| 数据分层     | 模板=data/ 只读；状态=SQLite(node:sqlite)                  | ADR-004  |
| LLM 供应商   | LLMProvider 接口；Mock + OpenAI 兼容 fetch                 | ADR-005  |
| 存档格式     | node:sqlite STRICT + WAL；Backup API 导出                  | ADR-006  |
| 状态日志     | snapshot + append-only hash chain；逻辑回滚                | ADR-007  |
| 迁移/分叉    | 前向迁移；分叉默认 fork                                    | ADR-008  |
| 确定性       | seed/cursor + Clock + stable SHA-256                       | ADR-009  |
| 人物卡       | 分层模板；模板/运行态/记忆三层分离；整卡 gameplay-adjusted | ADR-010  |
| 知识边界     | 六级可见性 + 认知标注；纯函数视图层；hidden 绝不进 Prompt  | ADR-011  |
| 人物记忆     | SQLite + 审批链 + 确定性规则评分；无向量库                 | ADR-012  |
| Prompt 管线  | 白名单注册表 + manifest + 固定九段 composer + 注入中和     | ADR-013  |
| Agent 契约   | 结构化建议输出；零写权限；受控修复；确定性一致性检查       | ADR-014  |
| 技术栈       | TypeScript 全栈、React+Vite、Fastify、Zod、Vitest          | docs/04  |
| 项目位置     | `@work/mandate-engine/` 独立目录（用户决策 1）             | progress |
| 存储         | node:sqlite（用户决策 3，薄仓储隔离可替换）                | docs/04  |

## 8. 协作约定

- 文档中文、代码标识符英文、关键注释中文；
- 提交信息：`<scope>: <中文简述>`；
- **不自动进入下一阶段**：每阶段完成需人工评审；
- **git 突变（commit/push 等）必须每次征得用户确认**；
- 架构级变更：先 ADR 后代码；改了已冻结设计须同步更新 docs；
- 每完成一个阶段/重要会话，在 `docs/progress/` 追加一份日期归档记录，并更新本文件第 2 节。
