/**
 * @mandate/domain —— 领域模型（docs/03-domain-model.md 的代码表达）。
 *
 * 分层：
 * - common.ts    通用值对象（HistoricalSource / Modifier / Resource / 模板元数据）
 * - templates.ts 历史模板实体（只读）
 * - runtime.ts   运行时实体（GameState 聚合根）
 * - meeting.ts   会议类型与规则环境
 */
export * from "./common";
export * from "./templates";
export * from "./runtime";
export * from "./meeting";
