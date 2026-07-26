import type {
  GameState,
  MeetingCancelCommand,
  MeetingConcludeCommand,
  MeetingCreateCommand,
  MeetingStartCommand,
  ProposedMutation,
} from "@mandate/domain";
import { StateEngineError } from "./errors";

/**
 * 会议生命周期命令的 Mutation Planner（Phase 4，ADR-015）。
 * 只处理进入 GameState 的最小投影（创建/开始/结束/取消）；
 * 会议内部推进（回合/议程/发言者）不经过这里，也不产生世界 revision。
 * 与其他 planner 一样：纯函数、先计划后校验、可逆。
 */

function mutation(
  input: Omit<ProposedMutation, "sourceIds" | "visibility"> &
    Partial<Pick<ProposedMutation, "sourceIds" | "visibility">>,
): ProposedMutation {
  return {
    ...input,
    sourceIds: input.sourceIds ?? [],
    visibility: input.visibility ?? "internal",
  };
}

type MeetingRecord = GameState["meetings"][string];

function meetingLogVisibility(record: MeetingRecord): "public" | "internal" | "sealed" {
  if (record.visibility === "sealed") return "sealed";
  if (record.visibility === "court" || record.type === "court-assembly") return "public";
  return "internal";
}

function requireMeeting(state: GameState, meetingId: string): MeetingRecord {
  const record = state.meetings[meetingId];
  if (!record) {
    throw new StateEngineError("MEETING_NOT_FOUND", `会议不存在：${meetingId}`);
  }
  return record;
}

export function planMeetingCreate(
  state: GameState,
  command: MeetingCreateCommand,
): ProposedMutation[] {
  const { meetingId, meetingType, participantIds, chairCharacterId, visibility } =
    command.payload;
  if (state.meetings[meetingId]) {
    throw new StateEngineError("MEETING_INVALID_STATE", `会议已存在：${meetingId}`);
  }
  const allParticipants = new Set(participantIds);
  allParticipants.add(chairCharacterId);
  for (const characterId of allParticipants) {
    if (characterId === "emperor") continue;
    const runtime = state.characters[characterId];
    if (!runtime) {
      throw new StateEngineError("MEETING_PARTICIPANT_INVALID", `参与者不存在：${characterId}`);
    }
    if (runtime.status !== "active") {
      throw new StateEngineError(
        "MEETING_PARTICIPANT_INVALID",
        `参与者当前不可与会（${runtime.status}）：${characterId}`,
      );
    }
  }
  const record: MeetingRecord = {
    meetingId,
    type: meetingType,
    status: "scheduled",
    participantIds: [...participantIds],
    chairCharacterId,
    visibility,
    sourceIds: command.payload.sourceIds ?? [],
  };
  return [
    mutation({
      aggregateType: "meeting",
      entityId: meetingId,
      operation: "add",
      path: `/meetings/${meetingId}`,
      before: null,
      after: record,
      reason: command.payload.reason,
      sourceIds: command.payload.sourceIds ?? [],
      visibility: meetingLogVisibility(record),
      tags: ["meeting", "lifecycle"],
    }),
  ];
}

export function planMeetingStart(
  state: GameState,
  command: MeetingStartCommand,
): ProposedMutation[] {
  const record = requireMeeting(state, command.payload.meetingId);
  if (record.status !== "scheduled") {
    throw new StateEngineError(
      record.status === "in-progress" ? "MEETING_ALREADY_STARTED" : "MEETING_INVALID_STATE",
      `会议无法开始（当前 ${record.status}）：${record.meetingId}`,
    );
  }
  const after: MeetingRecord = {
    ...structuredClone(record),
    status: "in-progress",
    startedAtRevision: state.revision + 1,
  };
  return [
    mutation({
      aggregateType: "meeting",
      entityId: record.meetingId,
      operation: "set",
      path: `/meetings/${record.meetingId}`,
      before: record,
      after,
      reason: command.payload.reason,
      visibility: meetingLogVisibility(record),
      tags: ["meeting", "lifecycle"],
    }),
  ];
}

export function planMeetingConclude(
  state: GameState,
  command: MeetingConcludeCommand,
): ProposedMutation[] {
  const record = requireMeeting(state, command.payload.meetingId);
  if (record.status === "concluded") {
    throw new StateEngineError(
      "MEETING_ALREADY_CONCLUDED",
      `会议已结束：${record.meetingId}`,
    );
  }
  if (record.status !== "in-progress") {
    throw new StateEngineError(
      "MEETING_INVALID_STATE",
      `会议无法结束（当前 ${record.status}）：${record.meetingId}`,
    );
  }
  const after: MeetingRecord = {
    ...structuredClone(record),
    status: "concluded",
    concludedAtRevision: state.revision + 1,
  };
  const mutations: ProposedMutation[] = [
    mutation({
      aggregateType: "meeting",
      entityId: record.meetingId,
      operation: "set",
      path: `/meetings/${record.meetingId}`,
      before: record,
      after,
      reason: command.payload.reason,
      visibility: meetingLogVisibility(record),
      tags: ["meeting", "lifecycle"],
    }),
  ];
  // 泄密评估触发的候选事件进入隐藏队列（sealed；Phase 5+ 的事件引擎消费）
  const leakCandidates = command.payload.leakEventCandidateIds ?? [];
  if (leakCandidates.length > 0) {
    const beforeQueue = state.hidden.queuedEventIds;
    const merged = [...beforeQueue, ...leakCandidates.filter((id) => !beforeQueue.includes(id))];
    mutations.push(
      mutation({
        aggregateType: "meeting",
        entityId: record.meetingId,
        operation: "set",
        path: "/hidden/queuedEventIds",
        before: beforeQueue,
        after: merged,
        reason: "秘密会议泄密风险候选事件",
        visibility: "sealed",
        tags: ["meeting", "leak-candidate"],
      }),
    );
  }
  return mutations;
}

export function planMeetingCancel(
  state: GameState,
  command: MeetingCancelCommand,
): ProposedMutation[] {
  const record = requireMeeting(state, command.payload.meetingId);
  if (record.status !== "scheduled" && record.status !== "in-progress") {
    throw new StateEngineError(
      "MEETING_INVALID_STATE",
      `会议无法取消（当前 ${record.status}）：${record.meetingId}`,
    );
  }
  const after: MeetingRecord = {
    ...structuredClone(record),
    status: "cancelled",
  };
  return [
    mutation({
      aggregateType: "meeting",
      entityId: record.meetingId,
      operation: "set",
      path: `/meetings/${record.meetingId}`,
      before: record,
      after,
      reason: command.payload.reason,
      visibility: meetingLogVisibility(record),
      tags: ["meeting", "lifecycle"],
    }),
  ];
}
