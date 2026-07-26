/**
 * @mandate/meeting-engine —— 会议编排引擎（Phase 4）。
 *
 * 全部为确定性纯逻辑：状态机、发言资格、发言调度、Meeting Director、
 * 结果候选映射与泄密评估。红线（ADR-016）：
 * - 不依赖 llm-adapters / agent-runtime（LLM 调用由 server 层按 Director 决策执行）；
 * - 无状态写入口：不 touch GameState / SQLite / StateChangeLog；
 * - 不用 LLM 做规则判断；随机仅用确定性 RNG。
 */
export * from "./errors";
export * from "./meeting-state-machine";
