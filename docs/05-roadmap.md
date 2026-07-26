# 05 · 项目路线图

每个阶段包含：阶段目标 / 前置条件 / 主要任务 / 交付物 / 验收标准 / 已知风险 / 明确不在该阶段完成的内容。
阶段原则上串行推进；每阶段完成后须人工评审再进入下一阶段。

## Phase 0 · 项目立项与架构基线（已完成）

- 目标：冻结愿景、需求、架构、领域模型、技术选型与项目骨架。
- 前置：无。
- 主要任务：文档（00–05 + ADR×5）；目录骨架；最小可运行代码（类型/接口/Mock）；质量保障文件。
- 交付物：docs 全套、apps/packages/data 骨架、最小测试。
- 验收标准：`npm install`、`lint`、`typecheck`、`test`、`build` 全部通过；
  无提前实现的业务功能。
- 风险：node:sqlite 为 experimental（CONFLICT-002）。
- 不做：任何业务逻辑、真实 LLM 调用、存档实现。

## Phase 1 · 基础项目骨架（已完成）

- 目标：前后端可启动并联调；配置装配；CI 式检查脚本就绪。
- 前置：Phase 0 验收通过。
- 主要任务：启动期配置与 Provider Factory；统一 API Envelope；Domain 深度 Schema 与引用校验；
  独立 Scenario Loader；场景元数据 API；类型化 Web Client 与 Runtime Dashboard；Prompt 最小资产；CI。
- 交付物：可运行的 `dev` / `dev:server` / `dev:web`；Config、Provider、Data Loader、Prompt、
  Dashboard 与离线测试闭环。
- 验收标准：固定 Node 环境下 `npm run check` 全绿；浏览器完成在线、刷新和离线验证；
  lint 与数据负向探针能阻断；默认 Mock 无需 Secrets 或外部网络。
- 风险：OpenAI 兼容端点差异（用 Mock 兜底）。
- 不做：游戏状态、存档、任何会议/政策逻辑。

## Phase 2 · 核心状态与存档系统（已完成）

- 目标：GameState 落地 + SQLite 存档 + StateChangeLog + 时间推进。
- 前置：Phase 1。
- 主要任务：GameState/Command/Mutation/StateChangeLog strict Schema；确定性 RNG/Clock；唯一状态写入口；
  SQLite 原子事务、checkpoint/replay、逻辑回滚、validate/repair dry-run、前向迁移；`.mesave` 加密导入导出与
  noop/fast-forward/forked/rejected 分类；Save API/CLI 与最小 Save Browser。
- 交付物：`@mandate/game-engine`、`@mandate/save-system`、15 个 Save API、6 个 CLI 命令、Phase 2 CI 门、
  ADR-006~009、真实性能基准与安全回归测试。
- 验收标准：固定 Node 24.18.0 下 `npm run check:phase2` 全绿；存档可创建、提交、重放、回滚、迁移、
  校验、导入导出；默认 View/API 不含 hidden/sealed；1000 revision 与 10000 日志基准有实测报告。
- 实际证据：`docs/06-phase-2-implementation.md`、`docs/progress/phase2-benchmark.json` 与 Phase 2 会话记录。
- 风险：`node:sqlite` 仍有 experimental 提示；同步 validate/export 在更大存档下可能需要 worker/异步化评审。
- 不做：Character Agent、完整会议/政策/规则/事件、云存档、自动 merge 或正式游戏 UI。

## Phase 3 · 人物卡与 Prompt 系统（已完成）

- 目标：Prompt 资产化管理 + Character Agent 单角色对话。
- 前置：Phase 2。
- 主要任务：分层人物卡 Schema 与首批 5 名人物数据；角色有限知识视图（六级可见性 +
  认知标注 + hidden/sealed 隔离）；人物记忆基础设施（SQLite 双表、Policy 审批、
  确定性 Selector、预算、规则摘要）；`prompt-system` 升级（23 个版本化资产、manifest、
  composer、预算裁剪、注入防护）；单人物 Character Agent（结构化输出、受控修复、
  确定性一致性检查、expectedRevision 校验）；人物 API 与 Character Lab；Mock Fixture 全离线测试。
- 交付物：`@mandate/agent-runtime` 实装、人物 API 6 端点、Character Lab、
  7 个新测试文件、ADR-010~014、`check:phase3` CI 门、Phase 3 性能基准。
- 验收标准：`check:phase3` 全绿；Prompt/视图不含越权信息（恶意输入测试）；
  Agent 调用不改变 GameState、不产生 StateChangeLog。
- 实际证据：`docs/07-phase-3-implementation.md`、`docs/progress/2026-07-26-phase3-session.md`、
  `docs/progress/phase3-benchmark.json`。
- 延后：农历日期显示方案评审（CONFLICT-001）与 Phase 7 一并处理；记忆语义检索留待后续评审。
- 不做：会议编排、政策解析、向量数据库。

## Phase 4 · 会议对话原型

- 目标：三种会议端到端可玩（Mock 或真实 LLM 均可驱动）。
- 前置：Phase 3。
- 主要任务：Meeting 状态机（scheduled→in_progress→concluded/leaked）；
  Meeting Director 流程控制；发言意愿/坦率受 MeetingRules 约束；
  会议记录（meeting_record）与泄密判定（种子随机）；SSE 流式发言；会议 UI 原型。
- 交付物：会议 API + UI 原型；会议状态机测试；泄密复现测试。
- 验收标准：FR-MEET-001~006。
- 风险：多 NPC 轮次成本与延迟（限制 MVP 参与人数）。
- 不做：政策结算、事件联动。

## Phase 5 · 政策与规则引擎

- 目标：自然语言指令 → 草案 → 校验 → 廷议 → 裁决 → 规则结算全链路。
- 前置：Phase 4。
- 主要任务：Policy Parser（结构化输出 + 重试降级）；制度约束检查（制度包）；
  Modifier 合成与结算；白名单条件 DSL 求值器（禁 eval）；
  执行偏差/地方阻力模型（简化版）；StateChangeLog 规则引用。
- 交付物：`rule-engine` 完整实现 + 确定性测试；Parser API；政策 UI 流程。
- 验收标准：FR-POL-001~004、FR-RULE-001/002、FR-TEST-001。
- 风险：DSL 表达力与安全的平衡（先小后大）；LLM 解析鲁棒性（Mock 测试兜底）。
- 不做：战争细化、复杂经济。

## Phase 6 · 事件和时间推进

- 目标：完整回合循环（结算顺序冻结）+ 事件系统。
- 前置：Phase 5。
- 主要任务：回合结算管线（到期 Modifier→财政/粮食→事件检测→衰减→风险累积）；
  固定/条件/动态事件；EventChain 基础；奏折生成管线（规则结果→LLM 文本）；
  时间推进 UI。
- 交付物：`event-engine`；奏折管线；回合推进测试。
- 验收标准：FR-EVT-001/002/003；FR-TEST-001 扩展。
- 风险：事件数据冷启动量不足（先用示例事件）。
- 不做：剧本全量事件。

## Phase 7 · 明末崇祯初政剧本

- 目标：MVP 剧本内容填充（8–12 核心人物 + 初始状态 + 首批事件链）。
- 前置：Phase 6。
- 主要任务：明朝制度包完善（内阁/六部/都察院/厂卫/地方督抚）；
  核心人物数据（魏忠贤、东林代表、袁崇焕、辽东将领、户兵两部要员等，
  全部带来源标注与四类确认状态）；阉党倒台事件链；辽东战局简化状态；
  财政/欠饷/灾害初始数据；农历日期换算复核。
- 交付物：`data/scenarios/chongzhen-early/` 完整数据；数据校验报告；
  Historian 标注报告（四类统计）。
- 验收标准：FR-HIST-001；剧本可从开局运行 ≥30 回合无致命错误。
- 风险：史料争议（标注而非定论）；数值平衡（先可玩后调优）。
- 不做：精细地图、复杂战争。

## Phase 8 · 完整游戏界面

- 目标：MVP 全部界面可用：御案、奏折、会议、官员档案、国家总览、政策、时间推进、存档管理、调试面板。
- 前置：Phase 7。
- 主要任务：`packages/ui` 组件库；各界面实现；存档槽位 UI；调试面板（hidden 可见开关）；
  服务端打包方案评审（tsup / 发布形态）。
- 交付物：完整 Web UI；FR-UI-001/002、FR-DEBUG-001、FR-SAVE-101 验收。
- 验收标准：新玩家可不看代码完成"开局→朝会→政策→推进十回合→读档"。
- 风险：UI 工作量膨胀（严守 MVP 清单）。
- 不做：地图着色（P1，若有余力再议）。

## Phase 9 · 测试、平衡和历史校验

- 目标：可发布质量。
- 前置：Phase 8。
- 主要任务：数值平衡（会议规则参数、财政/欠饷/民变模型）；长局回归测试（≥100 回合）；
  历史校验复审；性能与 Token 成本测量；文档更新。
- 交付物：平衡报告；回归测试套件；历史校验终稿。
- 验收标准：核心循环可重复游玩；所有 P0/P1 需求绿灯。
- 风险：平衡是开放问题（冻结参数表，接受迭代）。
- 不做：新功能。

## Phase 10 · 扩展朝代与创作者工具

- 目标：验证"制度包不改核心代码"承诺；开放创作。
- 前置：Phase 9。
- 主要任务：第二个朝代制度包试点（建议清或宋）；创作者数据校验 CLI；
  剧本编写指南；（P3）Tauri 桌面打包评估。
- 交付物：新朝代包；CLI 工具；创作文档。
- 验收标准：新增朝代仅新增 data/ 与必要规则数据，核心引擎零修改。
- 风险：第二朝代暴露架构假设（这正是本阶段目的）。
- 不做：mod 图形编辑器（P3）。
