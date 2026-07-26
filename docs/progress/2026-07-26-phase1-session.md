# 会话记录 · 2026-07-26 · Phase 1 基础工程与前后端联调闭环

## 1. 初始基线

- `main` 与 `origin/main` 同步、工作树干净，Phase 0 共 2 个提交；
- 主机最初为 Node 25.2.1 / npm 11.6.2，11 个 workspace；
- npm ci、lint、typecheck、19/19 test、build、语法级 check:data 全绿；
- Server 只有直写 health/version，Web 直接 fetch 且只有在线/离线，数据检查只解析 8 个 JSON；
- 已有 Domain 基础类型、Mock/OpenAI-compatible Adapter、Vite proxy、Zustand 和 Fastify 日志可复用。

## 2. 完成内容

1. 固定 Node 24.18.0 / npm 11.16.0；根脚本增加 dev、test:watch、check；
2. 唯一 Runtime Config Zod Schema、启动期条件校验与安全公开投影；
3. Provider Factory、LlmService、Mock 模型配置和 OpenAI 错误正文隔离；
4. `buildApp`/listen 分离、路由模块、统一成功/错误 Envelope 与日志脱敏；
5. Domain 严格模板 Schema、Scenario 状态字段、API DTO 与 LLM hidden 过滤；
6. 新建 `@mandate/data-loader`，统一 JSON/Schema/引用校验、深冻结 Bundle 和缓存；
7. 场景列表/详情 API，只返回元数据摘要；
8. Web API Client、五类状态的 Zustand store 与四卡 Runtime Dashboard；
9. 6 个注册式 `*.v1.md` Prompt 资产和最小变量 Renderer；
10. GitHub Actions、单元/路由/安全/集成测试及文档收口。

## 3. 验收证据

- 官方 Node ZIP 与 SHASUMS256 校验一致；固定运行时为 Node 24.18.0 / npm 11.16.0；
- 固定版本 `npm ci` 成功，依赖审计 0 vulnerabilities；
- 14 个 Vitest 文件、86/86 用例通过；9 个 JSON 通过深度校验；
- lint warning 探针 exit 1，删除后恢复；非法 Character 探针输出文件/实体/字段并 exit 1，删除后恢复；
- 浏览器验证 Dashboard 在线、Mock、`chongzhen-early`、手动刷新和 Server 停止后的离线状态；
- OpenAI-compatible 以本地占位 URL 成功装配且未调用模型；缺 Base URL 在 listen 前 exit 1；
- `.github/workflows/ci.yml` 仅完成本地静态与命令序列验证，本轮未提交或推送，故无远端 Actions 运行。

## 4. 真实遗留

- 历史模板仍为 Phase 1 占位数据，日期与史料内容留待 Phase 7 复核；
- OpenAI-compatible 尚未与真实供应商联调；
- GitHub Actions 需后续提交/推送后取得远端运行证据；
- 完整 Prompt 编排留待 Phase 3；GameState 与 SQLite 存档留待 Phase 2。

## 5. 下一步

Phase 2 实现 GameState、状态变更事务、StateChangeLog、存档仓储接口、SQLite 存档和
存档版本迁移；需人工评审后另行启动。
