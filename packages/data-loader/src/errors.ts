export type DataValidationIssueType =
  | "data-json-invalid"
  | "data-schema-invalid"
  | "data-reference-invalid"
  | "data-file-not-found";

export interface DataValidationIssue {
  type: DataValidationIssueType;
  file: string;
  entity?: string;
  path: string;
  message: string;
}

export class DataValidationError extends Error {
  constructor(readonly issues: readonly DataValidationIssue[]) {
    super(`历史数据校验失败：${issues.length} 个问题`);
    this.name = "DataValidationError";
  }
}

export type ScenarioLoaderErrorCode =
  | "SCENARIO_NOT_FOUND"
  | "DATA_FILE_NOT_FOUND"
  | "DATA_SCHEMA_INVALID";

export class ScenarioLoaderError extends Error {
  constructor(
    readonly code: ScenarioLoaderErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ScenarioLoaderError";
  }
}
