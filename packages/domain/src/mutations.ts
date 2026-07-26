import { z } from "zod";
import { CommandActorSchema } from "./commands";
import { JsonValueSchema } from "./state";

const IdSchema = z.string().trim().min(1);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type Hash = z.infer<typeof HashSchema>;

export const MutationOperationSchema = z.enum([
  "set",
  "add",
  "remove",
  "increment",
  "decrement",
  "patch",
]);
export type MutationOperation = z.infer<typeof MutationOperationSchema>;

export const MutationVisibilitySchema = z.enum(["public", "internal", "sealed"]);
export type MutationVisibility = z.infer<typeof MutationVisibilitySchema>;

export const JsonPointerSchema = z
  .string()
  .regex(/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/, "必须是非根 JSON Pointer");

export const ProposedMutationSchema = z
  .object({
    aggregateType: IdSchema,
    entityId: IdSchema.optional(),
    operation: MutationOperationSchema,
    path: JsonPointerSchema,
    before: JsonValueSchema,
    after: JsonValueSchema,
    reason: z.string().trim().min(1).optional(),
    sourceIds: z.array(IdSchema),
    visibility: MutationVisibilitySchema,
    tags: z.array(IdSchema).optional(),
  })
  .strict();
export type ProposedMutation = z.infer<typeof ProposedMutationSchema>;

export const InverseMutationSchema = z
  .object({
    operation: MutationOperationSchema,
    path: JsonPointerSchema,
    value: JsonValueSchema.optional(),
  })
  .strict();
export type InverseMutation = z.infer<typeof InverseMutationSchema>;

export const StateChangeLogEntrySchema = z
  .object({
    logId: IdSchema,
    saveId: IdSchema,
    revision: z.number().int().positive(),
    txId: IdSchema,
    sequence: z.number().int().nonnegative(),
    timestamp: z.iso.datetime(),
    actorType: CommandActorSchema.shape.type,
    actorId: IdSchema,
    commandType: IdSchema,
    commandId: IdSchema,
    aggregateType: IdSchema,
    entityId: IdSchema.optional(),
    operation: MutationOperationSchema,
    path: JsonPointerSchema,
    before: JsonValueSchema,
    after: JsonValueSchema,
    inverse: InverseMutationSchema.optional(),
    reason: z.string().trim().min(1).optional(),
    sourceIds: z.array(IdSchema),
    tags: z.array(IdSchema),
    visibility: MutationVisibilitySchema,
    beforeHash: HashSchema.optional(),
    afterHash: HashSchema,
    prevLogHash: HashSchema.nullable(),
    entryHash: HashSchema,
  })
  .strict();
export type StateChangeLogEntry = z.infer<typeof StateChangeLogEntrySchema>;
