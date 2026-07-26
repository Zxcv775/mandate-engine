# 天命：帝国推演（Mandate Engine）

> LLM 驱动的中国历史政治模拟游戏。
> **LLM 扮演人物、生成语言；规则引擎计算国家、结算后果。**

首个剧本：明末**崇祯初政**。玩家扮演刚刚登基的崇祯皇帝朱由检，
在阉党、党争、辽东战局与财政危机之间，用自己的决策改变历史。

## 当前开发阶段

**Phase 0 · 项目立项与架构基线**（详见 `docs/05-roadmap.md`）。

本阶段已冻结：项目愿景、需求规格（MVP 范围）、系统架构、领域模型、技术选型。
代码仅为最小骨架：领域类型定义、LLM 供应商接口与 Mock 实现、前后端最小可运行页面。
**尚未实现任何业务玩法。**

## 环境要求

- Node.js ≥ 22.5（存档功能依赖内置 `node:sqlite`；开发环境使用 25.x）
- npm ≥ 10

## 如何安装

```bash
npm install
```

## 如何启动

```bash
# 终端 1：后端（Fastify，默认 127.0.0.1:3000）
npm run dev:server

# 终端 2：前端（Vite，默认 5173 端口，/api 自动代理到后端）
npm run dev:web
```

浏览器打开 Vite 输出的地址，首页应显示"服务端状态：在线"。

## 如何测试与检查

```bash
npm run lint         # ESLint 静态检查
npm run typecheck    # 全部 workspace 的 TS 类型检查
npm test             # Vitest 单元测试（不触网，使用 Mock LLM）
npm run build        # 构建（web 产物 + 其余包编译验证）
npm run check:data   # data/ 目录 JSON 数据校验
```

## 目录结构

```text
apps/
  web/        # React + Vite 前端（御案/会议/奏折/调试面板，Phase 8 完善）
  server/     # Fastify 服务端（应用服务层）
packages/
  domain/         # 领域实体类型 + Zod Schema（25+ 实体，见 docs/03）
  shared/         # Result / SeededRng（种子随机）/ ID 等基础工具
  game-engine/    # 状态引擎、回合编排（Phase 2 实现）
  rule-engine/    # Modifier 合成、条件 DSL、判定（Phase 5 实现）
  event-engine/   # 事件检测与触发（Phase 6 实现）
  agent-runtime/  # Meeting Director / Character / Narrator 等逻辑角色（Phase 3-4）
  prompt-system/  # 提示词资产库（Phase 3）
  llm-adapters/   # LLMProvider 接口 + Mock + OpenAI 兼容适配器
  ui/             # 共享 UI 组件（Phase 8）
data/             # 历史模板数据（只读，带来源标注；运行时禁止修改）
  dynasties/  scenarios/  characters/  institutions/
  events/     rules/      worldbooks/  historical-sources/
scripts/          # 数据校验等脚本
tests/            # 跨包集成测试（Vitest）
config/           # 供应商配置示例等
docs/             # 愿景/需求/架构/领域模型/选型/路线图/ADR
```

## 核心设计原则

1. **规则优先，叙事后置**：先规则结算，后 LLM 写作；禁止文本反推数值；
2. **单一事实源**：唯一 GameState；一切修改写入 StateChangeLog；
3. **历史模板与运行状态分离**：模板只读、带史料来源标注；
4. **数据驱动**：朝代差异走制度包；规则 = Modifier + 白名单条件 DSL（禁 eval）；
5. **LLM 不可信**：输出经 Schema 校验；LLM 无状态写权限；
6. **可测试**：核心计算脱离 LLM；随机系统支持固定种子；
7. **三种会议是三种规则环境**（朝会/御前会议/秘密议事），不是聊天背景。

完整说明见 `docs/00-project-vision.md` 与 `docs/adr/`。

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改。默认 `LLM_PROVIDER=mock`，
不配置任何 Key 即可运行与测试。

## 许可证

当前保留所有权利，正式许可证待定（见 `LICENSE`）。

## 下一阶段（Phase 1 · 基础项目骨架）

- 服务端配置模块与 Provider 工厂；
- 前后端联调（健康检查）；
- 统一错误格式与 npm scripts 完善。

详见 `docs/05-roadmap.md`。**Phase 1 不会自动开始，需评审通过后启动。**
