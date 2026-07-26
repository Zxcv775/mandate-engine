import type { ApiErrorCode, ApiErrorDetail } from "@mandate/domain";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}
