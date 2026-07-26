/**
 * @mandate/game-engine —— 状态引擎与回合编排。
 *
 * 职责（docs/02 第 7 节）：GameState 唯一写入口、StateChangeLog、
 * 回合推进管线、自动存档触发。
 * 红线：本包禁止依赖 llm-adapters / agent-runtime（核心计算脱离 LLM 可测试）。
 *
 * 实现阶段：Phase 2（见 docs/05-roadmap.md）。Phase 0 仅预留包位置。
 */
export const PLANNED_PHASE = 2;
