# 贡献指南

感谢参与 **天命：帝国推演（Mandate Engine）** 的开发。本项目已完成 Phase 2 状态与存档底座，
一切贡献以 `docs/` 中的冻结文档为准绳。

## 开发环境

- Node.js `24.18.0`、npm `11.16.0`；版本分别由 `.nvmrc` 与 `packageManager` 固定；
- `npm ci` 后即可开发；无需任何外部服务与 API Key（默认 Mock LLM）。

## 常用命令

| 命令                       | 作用                                 |
| -------------------------- | ------------------------------------ |
| `npm run dev`              | 并发启动后端与前端                   |
| `npm run dev:server`       | 启动后端（tsx watch）                |
| `npm run dev:web`          | 启动前端（Vite）                     |
| `npm run lint`             | ESLint                               |
| `npm run typecheck`        | 全 workspace 类型检查                |
| `npm test`                 | Vitest（不触网）                     |
| `npm run build`            | 构建/编译验证                        |
| `npm run check:data`       | data/ JSON、Domain Schema 与引用校验 |
| `npm run check`            | 串行执行全部质量门禁                 |
| `npm run check:saves`      | 使用临时 SQLite 验证存档闭环         |
| `npm run check:phase2`     | 串行执行 Phase 2 全部门禁            |
| `npm run benchmark:phase2` | 生成真实状态/存档性能报告            |

提交前请确保以上命令全部通过。

## 不可逾越的红线

1. **LLM 不碰数值**：规则引擎是唯一数值结算方（ADR-002）；
2. **状态写入只有一个入口**：状态引擎；Agent/UI 不得直接改状态；
3. **模板只读**：`data/` 历史模板运行时禁止修改；新增模板必须带
   `meta.sourceIds` 与 `meta.confirmation` 标注；
4. **禁止 eval / new Function**：条件逻辑走白名单 DSL（ADR-003）；
5. **核心引擎不依赖 LLM**：`game-engine` / `rule-engine` / `event-engine`
   禁止 import `llm-adapters` / `agent-runtime`；
6. **随机必须可复现**：一律使用 `SeededRng`（packages/shared），禁止 `Math.random()`；
7. **历史诚实**：史实、争议、推测、可玩性调整四类标注，不得伪造定论。

## 代码风格

- TypeScript strict；ESM；缩进 2 空格；格式由 Prettier 统一（`npm run format`）；
- 标识符英文，注释与文档中文；注释解释"为什么"，不复述代码；
- 提交信息建议格式：`<scope>: <中文简述>`（如 `domain: 新增 MeetingRules 规则环境类型`）。

## 文档纪律

- 架构级变更必须先写/改 ADR（`docs/adr/`），再改代码；
- 修改了 `docs/` 中已冻结的设计，需在 PR 中明确说明并更新相关文档；
- 新需求进入 `docs/01-requirements.md` 并标注优先级与验收标准。

## 测试约定

- 核心逻辑（规则/状态/事件/存档）必须有单元测试；
- 测试不得触网：LLM 一律使用 `MockLLMProvider`；
- 涉及随机的测试必须固定种子。
- Repository/迁移/导入导出测试必须使用临时 SQLite，不得写入 `./saves/` 开发存档。
- 新增 Command 必须更新 discriminated union、StateEngine 穷尽分支、inverse/replay 与事务失败测试。
- 修改存档字段、hash 规范或 RNG 算法必须增加前向迁移并更新 ADR-006~009。
