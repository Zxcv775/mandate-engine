import type {
  CharacterRuntimeState,
  MeetingAgendaItem,
  MeetingParticipantState,
  MeetingSessionState,
} from "@mandate/domain";

/**
 * 发言资格策略（§9.1，确定性纯函数）。
 * 知识访问级别由调用方（server 层）用 agent-runtime 的可见性策略预计算后传入，
 * 保持本包不依赖 llm/agent 层（ADR-016）。
 */

export type TopicAccessLevel = "none" | "limited" | "normal" | "privileged";

export interface SpeakerEligibilityInput {
  readonly characterId: string;
  /** GameState.characters 中的运行态；不存在 = 人物不存在 */
  readonly runtime?: CharacterRuntimeState;
  readonly participant?: MeetingParticipantState;
  readonly session: MeetingSessionState;
  readonly agendaItem?: MeetingAgendaItem;
  /** 该人物对当前议题领域的访问级别（server 预计算） */
  readonly topicAccess: TopicAccessLevel;
  /** 本回合被皇帝点名（豁免 by-permission/observer/议题官职限制） */
  readonly emperorSelected: boolean;
}

export type IneligibilityReason =
  | "CHARACTER_MISSING"
  | "CHARACTER_NOT_ACTIVE"
  | "NOT_PARTICIPANT"
  | "NOT_PRESENT"
  | "SILENCED"
  | "OBSERVER_ONLY"
  | "PERMISSION_REQUIRED"
  | "AGENDA_OFFICE_REQUIRED"
  | "TURN_LIMIT_REACHED"
  | "AGENT_REQUEST_PENDING"
  | "NO_TOPIC_ACCESS";

export interface SpeakerEligibilityResult {
  readonly characterId: string;
  readonly eligible: boolean;
  readonly reasons: readonly IneligibilityReason[];
}

export function evaluateSpeakerEligibility(
  input: SpeakerEligibilityInput,
): SpeakerEligibilityResult {
  const reasons: IneligibilityReason[] = [];
  const { runtime, participant, session, agendaItem } = input;

  if (!runtime) {
    reasons.push("CHARACTER_MISSING");
  } else if (runtime.status !== "active") {
    // 覆盖：已死亡/去职不在京/被监禁/流放（Phase 3 口径：active = 在京可用）
    reasons.push("CHARACTER_NOT_ACTIVE");
  }

  if (!participant) {
    reasons.push("NOT_PARTICIPANT");
  } else {
    if (participant.attendance !== "present") reasons.push("NOT_PRESENT");
    if (participant.speakingRights === "silenced") reasons.push("SILENCED");
    if (participant.speakingRights === "observer-only" && !input.emperorSelected) {
      reasons.push("OBSERVER_ONLY");
    }
    if (
      participant.speakingRights === "by-permission" &&
      !input.emperorSelected &&
      participant.grantedByEmperorAtTurn === undefined
    ) {
      reasons.push("PERMISSION_REQUIRED");
    }
    if (participant.turnsSpoken >= session.limits.maxTurnsPerCharacter) {
      reasons.push("TURN_LIMIT_REACHED");
    }
  }

  if (
    agendaItem &&
    agendaItem.requiredOfficeIds.length > 0 &&
    !input.emperorSelected &&
    !(runtime?.officeId && agendaItem.requiredOfficeIds.includes(runtime.officeId))
  ) {
    reasons.push("AGENDA_OFFICE_REQUIRED");
  }

  if (session.pendingAgentAction) {
    reasons.push("AGENT_REQUEST_PENDING");
  }

  if (input.topicAccess === "none" && !input.emperorSelected) {
    reasons.push("NO_TOPIC_ACCESS");
  }

  return { characterId: input.characterId, eligible: reasons.length === 0, reasons };
}
