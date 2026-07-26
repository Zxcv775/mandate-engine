export type SaveSystemErrorCode =
  | "SAVE_NOT_FOUND"
  | "SAVE_ALREADY_EXISTS"
  | "SAVE_ARCHIVED"
  | "STATE_REVISION_CONFLICT"
  | "STATE_INVALID"
  | "STATE_LOG_INVALID"
  | "ROLLBACK_TARGET_INVALID"
  | "DATABASE_ERROR"
  | "MIGRATION_FAILED"
  | "CHECKPOINT_FAILED"
  | "SAVE_PACKAGE_INVALID"
  | "SAVE_DECRYPTION_FAILED"
  | "SAVE_VERSION_UNSUPPORTED"
  | "SAVE_IMPORT_FAILED"
  | "SAVE_EXPORT_FAILED"
  | "REPAIR_EXECUTION_NOT_SUPPORTED"
  | "MEETING_NOT_FOUND"
  | "MEETING_VERSION_STALE"
  | "MEETING_AGENT_RESPONSE_DUPLICATE"
  | "MEETING_TRANSCRIPT_WRITE_FAILED";

export class SaveSystemError extends Error {
  constructor(
    readonly code: SaveSystemErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SaveSystemError";
  }
}
