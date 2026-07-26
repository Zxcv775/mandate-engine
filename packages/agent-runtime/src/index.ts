/**
 * @mandate/agent-runtime —— Agent 编排层（Phase 3 实现单人物 Character Agent）。
 *
 * 分层：
 * - visibility-policy / character-view-builder  角色有限知识视图（ADR-011）
 * - memory/*                                    记忆策略、确定性选择器与受控摘要（ADR-012）
 * - character-context-builder                   只读上下文装配（§10）
 * - output-repair                               受控结构化输出修复（ADR-014）
 * - character-consistency-evaluator             确定性一致性检查（§15）
 * - character-agent                             单人物 Agent 编排（§11）
 * - mock-fixtures                               离线 Mock Fixture（§12）
 *
 * 红线：本层无状态写入口，只产出文本/结构化建议/记忆候选（ADR-002）。
 */
export * from "./errors";
export * from "./visibility-policy";
export * from "./character-view-builder";
export * from "./memory/memory-selector";
export * from "./memory/memory-policy";
export * from "./memory/memory-summary";
export * from "./character-context-builder";
export * from "./output-repair";
export * from "./character-consistency-evaluator";
export * from "./character-agent";
export * from "./mock-fixtures";
