/**
 * @mandate/domain —— 领域模型（docs/03-domain-model.md 的代码表达）。
 *
 * 分层：
 * - common.ts             通用值对象（HistoricalSource / Modifier / Resource / 模板元数据）
 * - templates.ts          历史模板实体（只读）
 * - character-template.ts 分层人物卡模板（Phase 3，ADR-010）
 * - character-view.ts     角色有限知识视图（Phase 3，ADR-011）
 * - character-memory.ts   人物记忆模型（Phase 3，ADR-012）
 * - character-agent.ts    Character Agent 输入输出契约（Phase 3，ADR-014）
 * - character-api.ts      人物交互 API 契约（Phase 3）
 * - runtime.ts            运行时实体（GameState 聚合根）
 * - meeting.ts            会议类型与规则环境
 */
export * from "./common";
export * from "./templates";
export * from "./runtime";
export * from "./meeting";
export * from "./api";
export * from "./state";
export * from "./commands";
export * from "./mutations";
export * from "./save";
export * from "./save-api";
export * from "./character-template";
export * from "./character-view";
export * from "./character-memory";
export * from "./character-agent";
export * from "./character-api";
export * from "./meeting-runtime";
export * from "./meeting-agent";
export * from "./meeting-api";
