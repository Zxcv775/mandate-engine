export type StateEngineErrorCode =
  | "COMMAND_INVALID"
  | "COMMAND_NOT_SUPPORTED"
  | "STATE_REVISION_CONFLICT"
  | "STATE_SAVE_MISMATCH"
  | "STATE_VALIDATION_FAILED"
  | "MUTATION_PATH_INVALID"
  | "MUTATION_BEFORE_MISMATCH"
  | "CHARACTER_NOT_FOUND"
  | "OFFICE_NOT_FOUND"
  | "OFFICE_OCCUPIED";

export class StateEngineError extends Error {
  constructor(
    readonly code: StateEngineErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StateEngineError";
  }
}
