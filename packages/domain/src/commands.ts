import { z } from "zod";

const IdSchema = z.string().trim().min(1);

export const CommandActorSchema = z
  .object({
    type: z.enum(["player", "system", "migration", "import"]),
    id: IdSchema,
  })
  .strict();
export type CommandActor = z.infer<typeof CommandActorSchema>;

const CommandBaseShape = {
  commandId: IdSchema,
  saveId: IdSchema,
  baseRevision: z.number().int().nonnegative(),
  actor: CommandActorSchema,
  idempotencyKey: IdSchema.optional(),
  createdAt: z.iso.datetime(),
};

export const CountryResourceNameSchema = z.enum([
  "treasuryTaels",
  "grainReserveShi",
  "legitimacy",
  "stability",
  "administrativeCapacity",
  "militaryReadiness",
]);
export type CountryResourceName = z.infer<typeof CountryResourceNameSchema>;

export const GameCreateCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("game.create"),
    payload: z
      .object({
        scenarioId: IdSchema,
        title: z.string().trim().min(1).max(120),
        seed: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const CountryAdjustResourceCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("country.adjust-resource"),
    payload: z
      .object({
        resource: CountryResourceNameSchema,
        delta: z.number().int().refine((value) => value !== 0, "调整量不得为零"),
        reason: z.string().trim().min(1),
        sourceIds: z.array(IdSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const CharacterAssignOfficeCommandSchema = z
  .object({
    ...CommandBaseShape,
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
  .strict();

export const TimeAdvanceCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("time.advance"),
    payload: z.object({ days: z.number().int().min(1).max(365) }).strict(),
  })
  .strict();

export const CheckpointKindSchema = z.enum([
  "initial",
  "periodic",
  "manual",
  "pre_migration",
  "pre_import",
]);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

export const CheckpointCreateCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("checkpoint.create"),
    payload: z
      .object({
        kind: CheckpointKindSchema,
        label: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();

export const SaveRollbackCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("save.rollback"),
    payload: z
      .object({
        targetRevision: z.number().int().nonnegative(),
        mode: z.literal("logical"),
        dryRun: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const GameCommandSchema = z.discriminatedUnion("commandType", [
  GameCreateCommandSchema,
  CountryAdjustResourceCommandSchema,
  CharacterAssignOfficeCommandSchema,
  TimeAdvanceCommandSchema,
  CheckpointCreateCommandSchema,
  SaveRollbackCommandSchema,
]);
export type GameCommand = z.infer<typeof GameCommandSchema>;
export type GameCreateCommand = z.infer<typeof GameCreateCommandSchema>;
export type CountryAdjustResourceCommand = z.infer<typeof CountryAdjustResourceCommandSchema>;
export type CharacterAssignOfficeCommand = z.infer<typeof CharacterAssignOfficeCommandSchema>;
export type TimeAdvanceCommand = z.infer<typeof TimeAdvanceCommandSchema>;
export type CheckpointCreateCommand = z.infer<typeof CheckpointCreateCommandSchema>;
export type SaveRollbackCommand = z.infer<typeof SaveRollbackCommandSchema>;
