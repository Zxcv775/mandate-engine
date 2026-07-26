/**
 * @mandate/agent-runtime —— Agent 编排层。
 *
 * 逻辑角色（早期由同一 LLM + 不同 Prompt 实现）：
 * Meeting Director（会议主持）、Character Agent（臣子扮演）、
 * Narrator（叙事）、Policy Parser（政策解析）、Historian（史实测注）、
 * Memory Manager（记忆整理）。
 * 红线：本层无状态写入口，只能产出文本/草案/摘要（ADR-002）。
 *
 * 实现阶段：Phase 3-4。Phase 0 仅预留包位置。
 */
export const PLANNED_PHASE = 3;
