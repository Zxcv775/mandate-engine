import { z } from "zod";
import {
  HistoricalDataCompletenessSchema,
  ScenarioStatusSchema,
} from "./templates";

export const ApiResponseMetaSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();
export type ApiResponseMeta = z.infer<typeof ApiResponseMetaSchema>;

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "CONFIG_INVALID",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_FAILED",
  "DATA_FILE_NOT_FOUND",
  "DATA_SCHEMA_INVALID",
  "SCENARIO_NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "SAVE_NOT_FOUND",
  "SAVE_ALREADY_EXISTS",
  "SAVE_ARCHIVED",
  "STATE_REVISION_CONFLICT",
  "STATE_INVALID",
  "STATE_LOG_INVALID",
  "ROLLBACK_TARGET_INVALID",
  "DATABASE_ERROR",
  "MIGRATION_FAILED",
  "CHECKPOINT_FAILED",
  "SAVE_PACKAGE_INVALID",
  "SAVE_DECRYPTION_FAILED",
  "SAVE_VERSION_UNSUPPORTED",
  "SAVE_IMPORT_FAILED",
  "SAVE_EXPORT_FAILED",
  "REPAIR_EXECUTION_NOT_SUPPORTED",
  "CHARACTER_NOT_FOUND",
  "CHARACTER_NOT_AVAILABLE",
  "CHARACTER_CONTEXT_STALE",
  "CHARACTER_VIEW_BUILD_FAILED",
  "CHARACTER_MEMORY_INVALID",
  "CHARACTER_MEMORY_LIMIT_EXCEEDED",
  "CHARACTER_OUTPUT_INVALID",
  "CHARACTER_CONSISTENCY_FAILED",
  "PROMPT_ASSET_NOT_FOUND",
  "PROMPT_VARIABLE_MISSING",
  "PROMPT_BUDGET_EXCEEDED",
  "LLM_OUTPUT_REPAIR_FAILED",
  "MEETING_NOT_FOUND",
  "MEETING_INVALID_STATE",
  "MEETING_VERSION_STALE",
  "MEETING_ALREADY_STARTED",
  "MEETING_ALREADY_CONCLUDED",
  "MEETING_PARTICIPANT_INVALID",
  "MEETING_PARTICIPANT_NOT_PRESENT",
  "MEETING_SPEAKER_INELIGIBLE",
  "MEETING_AGENDA_NOT_FOUND",
  "MEETING_AGENDA_INVALID_STATE",
  "MEETING_TURN_LIMIT_REACHED",
  "MEETING_ACTION_NOT_ALLOWED",
  "MEETING_AGENT_REQUEST_PENDING",
  "MEETING_AGENT_RESPONSE_DUPLICATE",
  "MEETING_TRANSCRIPT_WRITE_FAILED",
  "MEETING_OUTCOME_INVALID",
  "MEETING_OUTCOME_UNSUPPORTED",
  "MEETING_RULING_INVALID",
  "MEETING_RECOVERY_REQUIRED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorDetailSchema = z
  .object({
    path: z.string(),
    message: z.string().min(1),
    type: z.string().min(1),
  })
  .strict();
export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

export const ApiErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1),
        details: z.array(ApiErrorDetailSchema).optional(),
      })
      .strict(),
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const HealthDataSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("mandate-server"),
    timestamp: z.iso.datetime(),
  })
  .strict();
export type HealthData = z.infer<typeof HealthDataSchema>;

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    data: HealthDataSchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const VersionDataSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    phase: z.number().int().nonnegative(),
  })
  .strict();
export type VersionData = z.infer<typeof VersionDataSchema>;

export const VersionResponseSchema = z
  .object({
    ok: z.literal(true),
    data: VersionDataSchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

export const PublicRuntimeConfigSchema = z
  .object({
    environment: z.enum(["development", "test", "production"]),
    provider: z
      .object({
        name: z.enum(["mock", "openai-compatible"]),
        model: z.string().min(1),
        hasApiKey: z.boolean(),
        baseUrlConfigured: z.boolean(),
        isMock: z.boolean(),
      })
      .strict(),
    scenario: z
      .object({
        defaultScenarioId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;

export const RuntimeConfigResponseSchema = z
  .object({
    ok: z.literal(true),
    data: PublicRuntimeConfigSchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type RuntimeConfigResponse = z.infer<typeof RuntimeConfigResponseSchema>;

export const ScenarioSummarySchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    dynastyId: z.string().trim().min(1),
    dynastyName: z.string().trim().min(1),
    startGameDate: z.iso.date(),
    status: ScenarioStatusSchema,
    historicalDataCompleteness: HistoricalDataCompletenessSchema,
    schemaValidated: z.literal(true),
  })
  .strict();
export type ScenarioSummary = z.infer<typeof ScenarioSummarySchema>;

export const ScenarioListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.array(ScenarioSummarySchema),
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type ScenarioListResponse = z.infer<typeof ScenarioListResponseSchema>;

export const ScenarioResponseSchema = z
  .object({
    ok: z.literal(true),
    data: ScenarioSummarySchema,
    meta: ApiResponseMetaSchema,
  })
  .strict();
export type ScenarioResponse = z.infer<typeof ScenarioResponseSchema>;
