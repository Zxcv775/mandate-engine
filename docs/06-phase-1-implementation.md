# 06 · Phase 1 实施说明

## 1. 目标与边界

Phase 1 建立可验证、默认离线、可联调的工程底座，不实现 GameState、存档或玩法。
所有测试与 CI 使用 Mock Provider；OpenAI-compatible 只完成启动装配边界。

## 2. Server 装配顺序

```text
process.env
→ parseRuntimeConfig（唯一读取/解析点）
→ createLlmProvider
→ createLlmService
→ createScenarioLoader
→ 预载 DEFAULT_SCENARIO_ID
→ buildApp 注册错误处理和路由
→ index.ts listen
```

`index.ts` 只负责启动；`buildApp()` 可注入 Provider、ScenarioLoader、数据根目录和日志流，
路由测试通过 Fastify `inject()` 完成，不监听 TCP。

## 3. API Envelope

成功：

```json
{ "ok": true, "data": {}, "meta": { "requestId": "..." } }
```

错误：

```json
{
  "ok": false,
  "error": { "code": "...", "message": "...", "details": [] },
  "meta": { "requestId": "..." }
}
```

DTO 与 Zod Schema 位于 `@mandate/domain`，前后端共用。未知异常只返回
`INTERNAL_ERROR`，堆栈只进入服务端日志；Authorization 和 `apiKey` 字段强制脱敏。

## 4. Provider 与配置

- Config Schema 校验端口、日志级别、Provider、URL、模型、超时、重试与默认场景；
- Mock 为默认值且不需要 Base URL 或 Key；
- OpenAI-compatible 必须有 http(s) Base URL 和模型，Key 可选；
- Provider Factory 位于 Server，因为它负责将应用配置装配到内部适配器；
- LlmService 注入默认 model/timeout/retries，只记录安全调用元数据。

## 5. Data Loader

`@mandate/data-loader` 是独立 workspace，供 CLI、Server 与测试共用，避免脚本复制 Schema。
它负责 JSON 解析、Domain Schema、来源与实体引用校验，并以 `import.meta.url` 推导默认路径。
场景 Bundle 经过 `structuredClone` 和深冻结；简单进程缓存可由测试清除。

当前引用校验覆盖 Scenario→Dynasty/Character、Dynasty→InstitutionPack、
Character→Faction、Office→Institution、机构父级、initialDataRef 和所有 sourceIds。

## 6. Prompt 资产

`@mandate/prompt-system` 通过固定注册表将 6 个 Prompt ID 映射到 `*.v1.md`；调用方不能把
任意字符串当作文件路径。Renderer 只支持 `{{name}}` 全量替换并聚合报告缺失变量，
没有条件、循环、检索或 Agent 编排。

## 7. Runtime Dashboard

Web 端原生 fetch Client 统一处理 Base URL、超时、取消、JSON、非 2xx Error Envelope 和
Domain Schema。Zustand store 并发加载 health/version/runtime，随后按默认场景 ID 加载摘要；
四张卡片分别维护 `loading/success/offline/api_error/data_error`，刷新会取消旧请求。

## 8. CI

`.github/workflows/ci.yml` 在 main push 与 pull request 上运行，使用 `.nvmrc`、npm cache、
只读仓库权限、Mock 环境和 15 分钟超时。命令依次为 `npm ci`、lint、typecheck、test、
build、check:data，不需要 Secrets。

## 9. Phase 2 入口

Phase 2 只在 Phase 1 人工验收后开始，范围为 GameState、事务化状态变更、
StateChangeLog、存档仓储接口、SQLite 存档与版本迁移。
