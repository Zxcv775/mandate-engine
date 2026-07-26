import {
  MeetingSessionStateSchema,
  MeetingStateEventSchema,
  type MeetingSessionState,
  type MeetingSessionStatus,
  type MeetingStateEvent,
} from "@mandate/domain";
import { MeetingEngineError } from "./errors";

/**
 * Meeting State Machine（ADR-015）。
 * 纯函数：transition(state, event) → 新状态副本；非法转换抛 MEETING_INVALID_STATE。
 * 每次成功转换 meetingVersion + 1（乐观锁推进由仓储落库时校验）。
 *
 * 转换矩阵（事件 → 允许的起始状态 → 目标状态）：
 *   meeting.schedule           draft → scheduled
 *   meeting.start-preparation  scheduled → preparing
 *   meeting.start              preparing → in-progress
 *   meeting.await-player       in-progress → waiting-for-player
 *   meeting.await-agent        in-progress → waiting-for-agent
 *   meeting.agent-completed    waiting-for-agent → in-progress
 *   meeting.step-completed     waiting-for-player → in-progress
 *   meeting.open-agenda        in-progress → in-progress（校验议程存在于 agendaItemIds）
 *   meeting.begin-resolution   in-progress | waiting-for-player → resolving
 *   meeting.resolve-agenda     resolving → in-progress
 *   meeting.pause              in-progress | waiting-for-player | waiting-for-agent
 *                              | resolving | failed → paused
 *   meeting.resume             paused → in-progress
 *   meeting.conclude           in-progress | resolving | waiting-for-player → concluded
 *   meeting.cancel             draft | scheduled | preparing | paused | failed → cancelled
 *   meeting.fail               in-progress | waiting-for-agent | resolving → failed
 * 终态：concluded 与 cancelled 不接受任何事件（含重复 conclude/cancel）。
 */

export interface MeetingTransitionResult {
  readonly next: MeetingSessionState;
  readonly from: MeetingSessionStatus;
  readonly to: MeetingSessionStatus;
}

type TransitionRule = {
  readonly allowedFrom: readonly MeetingSessionStatus[];
  readonly to: MeetingSessionStatus;
  apply?(state: MeetingSessionState, event: MeetingStateEvent): void;
};

const RULES: Readonly<Record<MeetingStateEvent["type"], TransitionRule>> = {
  "meeting.schedule": { allowedFrom: ["draft"], to: "scheduled" },
  "meeting.start-preparation": { allowedFrom: ["scheduled"], to: "preparing" },
  "meeting.start": {
    allowedFrom: ["preparing"],
    to: "in-progress",
  },
  "meeting.await-player": {
    allowedFrom: ["in-progress"],
    to: "waiting-for-player",
    apply(state, event) {
      if (event.type !== "meeting.await-player") return;
      state.pendingPlayerAction = structuredClone(event.action);
    },
  },
  "meeting.await-agent": {
    allowedFrom: ["in-progress"],
    to: "waiting-for-agent",
    apply(state, event) {
      if (event.type !== "meeting.await-agent") return;
      state.currentSpeakerId = event.characterId;
    },
  },
  "meeting.agent-completed": {
    allowedFrom: ["waiting-for-agent"],
    to: "in-progress",
    apply(state, event) {
      if (event.type !== "meeting.agent-completed") return;
      if (state.pendingAgentAction && state.pendingAgentAction.characterId !== event.characterId) {
        throw new MeetingEngineError(
          "MEETING_INVALID_STATE",
          `等待的发言者是 ${state.pendingAgentAction.characterId}，收到 ${event.characterId}`,
        );
      }
      delete state.pendingAgentAction;
      delete state.currentSpeakerId;
    },
  },
  "meeting.step-completed": {
    allowedFrom: ["waiting-for-player"],
    to: "in-progress",
    apply(state) {
      delete state.pendingPlayerAction;
    },
  },
  "meeting.open-agenda": {
    allowedFrom: ["in-progress"],
    to: "in-progress",
    apply(state, event) {
      if (event.type !== "meeting.open-agenda") return;
      if (!state.agendaItemIds.includes(event.agendaItemId)) {
        throw new MeetingEngineError(
          "MEETING_AGENDA_NOT_FOUND",
          `议程不属于本会议：${event.agendaItemId}`,
        );
      }
      state.currentAgendaItemId = event.agendaItemId;
    },
  },
  "meeting.begin-resolution": {
    allowedFrom: ["in-progress", "waiting-for-player"],
    to: "resolving",
    apply(state) {
      delete state.pendingPlayerAction;
    },
  },
  "meeting.resolve-agenda": {
    allowedFrom: ["resolving"],
    to: "in-progress",
    apply(state, event) {
      if (event.type !== "meeting.resolve-agenda") return;
      if (state.currentAgendaItemId !== event.agendaItemId) {
        throw new MeetingEngineError(
          "MEETING_AGENDA_INVALID_STATE",
          `当前裁决议程不是 ${event.agendaItemId}`,
        );
      }
      delete state.currentAgendaItemId;
    },
  },
  "meeting.pause": {
    allowedFrom: ["in-progress", "waiting-for-player", "waiting-for-agent", "resolving", "failed"],
    to: "paused",
    apply(state, event) {
      if (event.type !== "meeting.pause") return;
      state.pauseReason = event.reason;
    },
  },
  "meeting.resume": {
    allowedFrom: ["paused"],
    to: "in-progress",
    apply(state) {
      delete state.pauseReason;
      delete state.failureCode;
    },
  },
  "meeting.conclude": {
    allowedFrom: ["in-progress", "resolving", "waiting-for-player"],
    to: "concluded",
    apply(state) {
      delete state.pendingPlayerAction;
      delete state.pendingAgentAction;
      delete state.currentSpeakerId;
    },
  },
  "meeting.cancel": {
    allowedFrom: ["draft", "scheduled", "preparing", "paused", "failed"],
    to: "cancelled",
    apply(state, event) {
      if (event.type !== "meeting.cancel") return;
      state.pauseReason = event.reason;
      delete state.pendingPlayerAction;
      delete state.pendingAgentAction;
      delete state.currentSpeakerId;
    },
  },
  "meeting.fail": {
    allowedFrom: ["in-progress", "waiting-for-agent", "resolving"],
    to: "failed",
    apply(state, event) {
      if (event.type !== "meeting.fail") return;
      state.failureCode = event.errorCode;
    },
  },
};

export function transitionMeeting(
  inputState: Readonly<MeetingSessionState>,
  inputEvent: MeetingStateEvent,
): MeetingTransitionResult {
  const state = MeetingSessionStateSchema.parse(inputState);
  const event = MeetingStateEventSchema.parse(inputEvent);
  const rule = RULES[event.type];
  if (!rule.allowedFrom.includes(state.status)) {
    throw new MeetingEngineError(
      "MEETING_INVALID_STATE",
      `事件 ${event.type} 不允许从状态 ${state.status} 触发`,
    );
  }
  const next = structuredClone(state);
  rule.apply?.(next, event);
  next.status = rule.to;
  next.meetingVersion = state.meetingVersion + 1;
  return { next: MeetingSessionStateSchema.parse(next), from: state.status, to: rule.to };
}

/** 供测试与文档使用的完整转换矩阵视图 */
export function describeTransitionMatrix(): ReadonlyArray<{
  event: MeetingStateEvent["type"];
  allowedFrom: readonly MeetingSessionStatus[];
  to: MeetingSessionStatus;
}> {
  return Object.entries(RULES).map(([event, rule]) => ({
    event: event as MeetingStateEvent["type"],
    allowedFrom: rule.allowedFrom,
    to: rule.to,
  }));
}
