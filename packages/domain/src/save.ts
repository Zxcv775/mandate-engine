import { z } from "zod";
import { CheckpointKindSchema } from "./commands";
import { HashSchema } from "./mutations";

const IdSchema = z.string().trim().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const SaveStatusSchema = z.enum(["active", "archived", "deleted"]);
export type SaveStatus = z.infer<typeof SaveStatusSchema>;

export const SourceMetadataModeSchema = z.enum(["full", "omit_catalog"]);
export type SourceMetadataMode = z.infer<typeof SourceMetadataModeSchema>;

export const SaveMetadataSchema = z
  .object({
    saveId: IdSchema,
    scenarioId: IdSchema,
    dynastyId: IdSchema,
    title: z.string().trim().min(1).max(120),
    status: SaveStatusSchema,
    headRevision: NonNegativeIntegerSchema,
    schemaVersion: z.number().int().positive(),
    stateVersion: z.number().int().positive(),
    lineageId: IdSchema,
    parentSaveId: IdSchema.nullable(),
    sourceMetadataMode: SourceMetadataModeSchema,
    currentDate: z.iso.date(),
    snapshotCount: NonNegativeIntegerSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lastPlayedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type SaveMetadata = z.infer<typeof SaveMetadataSchema>;

export const CheckpointMetadataSchema = z
  .object({
    snapshotId: IdSchema,
    saveId: IdSchema,
    revision: NonNegativeIntegerSchema,
    kind: CheckpointKindSchema,
    label: z.string().trim().min(1).max(200).nullable(),
    stateHash: HashSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export type CheckpointMetadata = z.infer<typeof CheckpointMetadataSchema>;

export const SafeShareModeSchema = z.enum([
  "none",
  "strip_source_catalog",
  "strip_sealed_notes",
  "safe_share",
]);
export type SafeShareMode = z.infer<typeof SafeShareModeSchema>;

export const SaveExportManifestSchema = z
  .object({
    exportFormatVersion: z.number().int().positive(),
    appVersion: z.string().trim().min(1),
    saveId: IdSchema,
    lineageId: IdSchema,
    scenarioId: IdSchema,
    dynastyId: IdSchema,
    schemaVersion: z.number().int().positive(),
    stateVersion: z.number().int().nonnegative(),
    baseRevision: NonNegativeIntegerSchema,
    headRevision: NonNegativeIntegerSchema,
    exportedAt: z.iso.datetime(),
    includeSourceMetadata: z.boolean(),
    sourceMetadataMode: SourceMetadataModeSchema,
    encrypted: z.boolean(),
    safeShareMode: SafeShareModeSchema,
    exportedFromClientId: IdSchema.optional(),
  })
  .strict();
export type SaveExportManifest = z.infer<typeof SaveExportManifestSchema>;

export const ImportResultKindSchema = z.enum([
  "noop",
  "fast_forward",
  "forked",
  "rejected",
  "failed",
]);
export type ImportResultKind = z.infer<typeof ImportResultKindSchema>;

export const SaveImportResultSchema = z
  .object({
    result: ImportResultKindSchema,
    saveId: IdSchema,
    originalSaveId: IdSchema.optional(),
    headRevision: NonNegativeIntegerSchema,
    packageHash: HashSchema,
    message: z.string().trim().min(1),
  })
  .strict();
export type SaveImportResult = z.infer<typeof SaveImportResultSchema>;

export const SaveValidationCheckSchema = z
  .object({
    code: IdSchema,
    status: z.enum(["passed", "warning", "failed"]),
    message: z.string().trim().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export const SaveValidationReportSchema = z
  .object({
    valid: z.boolean(),
    checks: z.array(SaveValidationCheckSchema),
  })
  .strict();
export type SaveValidationReport = z.infer<typeof SaveValidationReportSchema>;

export const RepairActionSchema = z
  .object({
    code: IdSchema,
    description: z.string().trim().min(1),
    applicable: z.boolean(),
  })
  .strict();

export const SaveRepairPlanSchema = z
  .object({
    saveId: IdSchema,
    dryRun: z.boolean(),
    actions: z.array(RepairActionSchema),
    validation: SaveValidationReportSchema,
  })
  .strict();
export type SaveRepairPlan = z.infer<typeof SaveRepairPlanSchema>;
