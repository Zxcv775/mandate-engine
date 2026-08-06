import { z } from "zod";
import { CountryResourceNameSchema } from "./commands";
import { SafeShareModeSchema } from "./save";
import { SaveMetadataSchema } from "./save";
import { PlayerStateViewSchema } from "./state";
import { StateChangeLogEntrySchema } from "./mutations";
import { ApiResponseMetaSchema } from "./api";

/** 存档导入的统一线格式上限：16 MiB ZIP，经 base64 后约 21.34 MiB。 */
export const MAX_SAVE_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_SAVE_IMPORT_BASE64_LENGTH = Math.ceil(MAX_SAVE_ARCHIVE_BYTES / 3) * 4;
export const SAVE_IMPORT_HTTP_BODY_LIMIT = MAX_SAVE_IMPORT_BASE64_LENGTH + 16 * 1024;

const IdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const SaveIdParamsSchema = z.object({ saveId: IdSchema }).strict();

export const CreateSaveRequestSchema = z
  .object({
    saveId: IdSchema.optional(),
    scenarioId: IdSchema,
    title: z.string().trim().min(1).max(120),
    seed: z.string().min(1).max(512),
  })
  .strict();
export type CreateSaveRequest = z.infer<typeof CreateSaveRequestSchema>;

export const SaveListQuerySchema = z
  .object({
    includeArchived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

const PlayerCommandBaseShape = {
  commandId: IdSchema,
  baseRevision: z.number().int().nonnegative(),
  idempotencyKey: IdSchema.optional(),
};

export const SubmitCommandRequestSchema = z.discriminatedUnion("commandType", [
  z
    .object({
      ...PlayerCommandBaseShape,
      commandType: z.literal("country.adjust-resource"),
      payload: z
        .object({
          resource: CountryResourceNameSchema,
          delta: z
            .number()
            .int()
            .refine((value) => value !== 0),
          reason: z.string().trim().min(1),
          sourceIds: z.array(IdSchema).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...PlayerCommandBaseShape,
      commandType: z.literal("character.assign-office"),
      payload: z
        .object({
          characterId: IdSchema,
          officeId: IdSchema.nullable(),
          reason: z.string().trim().min(1).optional(),
          sourceIds: z.array(IdSchema).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type SubmitCommandRequest = z.infer<typeof SubmitCommandRequestSchema>;

export const AdvanceTimeRequestSchema = z
  .object({
    commandId: IdSchema,
    baseRevision: z.number().int().nonnegative(),
    days: z.number().int().min(1).max(365),
    idempotencyKey: IdSchema.optional(),
  })
  .strict();

export const CreateCheckpointRequestSchema = z
  .object({
    kind: z.enum(["manual", "periodic"]),
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const optionalIntegerQuery = z.string().regex(/^\d+$/).transform(Number).optional();

export const SaveChangesQuerySchema = z
  .object({
    fromRevision: optionalIntegerQuery,
    toRevision: optionalIntegerQuery,
    commandType: IdSchema.optional(),
    actorType: IdSchema.optional(),
    aggregateType: IdSchema.optional(),
    entityId: IdSchema.optional(),
    visibility: z.enum(["public", "internal"]).optional(),
    limit: optionalIntegerQuery,
    cursor: optionalIntegerQuery,
  })
  .strict();

export const RollbackRequestSchema = z
  .object({
    targetRevision: z.number().int().nonnegative(),
    mode: z.literal("logical"),
    dryRun: z.boolean().default(true),
  })
  .strict();

export const RepairRequestSchema = z
  .object({
    dryRun: z.boolean(),
    allowHeadRebuild: z.boolean().default(false),
    allowIndexRebuild: z.boolean().default(false),
    allowSnapshotRebuild: z.boolean().default(false),
  })
  .strict();

export const ExportSaveRequestSchema = z
  .object({
    includeSourceMetadata: z.boolean().default(true),
    safeShareMode: SafeShareModeSchema.default("none"),
    password: z.string().min(8).max(1_024).optional(),
    exportedFromClientId: IdSchema.optional(),
  })
  .strict();

export const ImportSaveRequestSchema = z
  .object({
    packageBase64: z.string().min(1).max(MAX_SAVE_IMPORT_BASE64_LENGTH),
    password: z.string().min(8).max(1_024).optional(),
    clientId: IdSchema.optional(),
  })
  .strict();

function successEnvelope<DataSchema extends z.ZodType>(data: DataSchema) {
  return z
    .object({
      ok: z.literal(true),
      data,
      meta: ApiResponseMetaSchema,
    })
    .strict();
}

export const SaveMetadataResponseSchema = successEnvelope(SaveMetadataSchema);
export const SaveListResponseSchema = successEnvelope(z.array(SaveMetadataSchema));
export const SaveStateResponseSchema = successEnvelope(PlayerStateViewSchema);
export const SaveChangesResponseSchema = successEnvelope(z.array(StateChangeLogEntrySchema));
