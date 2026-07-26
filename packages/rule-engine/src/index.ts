/**
 * @mandate/rule-engine —— 规则引擎。
 *
 * 职责（ADR-003）：Modifier 收集/合成/结算、白名单条件 DSL 求值（禁 eval）、
 * 种子随机判定、执行偏差与风险累积。
 * 红线：禁止 eval / new Function；随机一律使用 SeededRng；
 * 本包禁止依赖 llm-adapters / agent-runtime。
 *
 * 实现阶段：Phase 5。Phase 0 仅预留包位置。
 */
export const PLANNED_PHASE = 5;
