import type { ApiErrorCode } from "@mandate/domain";

/** Meeting Engine 统一错误：code 对齐 domain 的 ApiErrorCode，便于 API 层直接映射 */
export class MeetingEngineError extends Error {
  constructor(
    readonly code: Extract<
      ApiErrorCode,
      | "MEETING_NOT_FOUND"
      | "MEETING_INVALID_STATE"
      | "MEETING_VERSION_STALE"
      | "MEETING_ALREADY_STARTED"
      | "MEETING_ALREADY_CONCLUDED"
      | "MEETING_PARTICIPANT_INVALID"
      | "MEETING_PARTICIPANT_NOT_PRESENT"
      | "MEETING_SPEAKER_INELIGIBLE"
      | "MEETING_AGENDA_NOT_FOUND"
      | "MEETING_AGENDA_INVALID_STATE"
      | "MEETING_TURN_LIMIT_REACHED"
      | "MEETING_ACTION_NOT_ALLOWED"
      | "MEETING_AGENT_REQUEST_PENDING"
      | "MEETING_AGENT_RESPONSE_DUPLICATE"
      | "MEETING_TRANSCRIPT_WRITE_FAILED"
      | "MEETING_OUTCOME_INVALID"
      | "MEETING_OUTCOME_UNSUPPORTED"
      | "MEETING_RULING_INVALID"
      | "MEETING_RECOVERY_REQUIRED"
    >,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "MeetingEngineError";
  }
}
