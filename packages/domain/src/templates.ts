import { z } from "zod";
import { ModifierSchema, TemplateMetaSchema } from "./common";

const IdSchema = z.string().trim().min(1);
const NameSchema = z.string().trim().min(1);
const YearSchema = z.number().int().min(0).max(9_999);

/** 模板侧实体（只读，存于 data/，git 版本控制）。 */
export const DynastySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    startYear: YearSchema,
    endYear: YearSchema.optional(),
    institutionPackId: IdSchema,
    meta: TemplateMetaSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endYear !== undefined && value.endYear < value.startYear) {
      context.addIssue({
        code: "custom",
        path: ["endYear"],
        message: "结束年份不得早于开始年份",
      });
    }
  });
export type Dynasty = z.infer<typeof DynastySchema>;

export const ScenarioStatusSchema = z.enum(["prototype", "playable"]);
export type ScenarioStatus = z.infer<typeof ScenarioStatusSchema>;

export const HistoricalDataCompletenessSchema = z.enum(["placeholder", "partial", "complete"]);
export type HistoricalDataCompleteness = z.infer<typeof HistoricalDataCompletenessSchema>;

export const ScenarioSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    dynastyId: IdSchema,
    startGameDate: z.iso.date(),
    synopsis: z.string().trim().min(1),
    initialDataRef: z.string().trim().min(1),
    coreCharacterIds: z.array(IdSchema).min(1),
    status: ScenarioStatusSchema,
    historicalDataCompleteness: HistoricalDataCompletenessSchema,
    meta: TemplateMetaSchema,
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * 人物模板已在 Phase 3 升级为分层人物卡（见 character-template.ts / ADR-010）。
 * 此处保留 Character/CharacterSchema 别名，兼容 data-loader 与 game-engine 的既有引用。
 */
export {
  CharacterTemplateSchema as CharacterSchema,
  type CharacterTemplate as Character,
} from "./character-template";

export const OfficeSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    grade: z.number().int().min(1).max(9),
    institutionId: IdSchema,
    powers: z.array(z.string().trim().min(1)).min(1),
    quota: z.number().int().nonnegative(),
    meta: TemplateMetaSchema,
  })
  .strict();
export type Office = z.infer<typeof OfficeSchema>;

export const InstitutionTypeSchema = z.enum([
  "decision",
  "administration",
  "censorate",
  "military",
  "fiscal",
  "intelligence",
  "palace",
  "local",
]);
export type InstitutionType = z.infer<typeof InstitutionTypeSchema>;

export const InstitutionSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    type: InstitutionTypeSchema,
    parentId: IdSchema.optional(),
    functions: z.array(z.string().trim().min(1)).min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type Institution = z.infer<typeof InstitutionSchema>;

export const InstitutionPackSchema = z
  .object({
    id: IdSchema,
    dynastyId: IdSchema,
    institutions: z.array(InstitutionSchema).min(1),
    offices: z.array(OfficeSchema),
    decisionStructure: z.string().trim().min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type InstitutionPack = z.infer<typeof InstitutionPackSchema>;

export const FactionSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    ideology: z.string().trim().min(1).optional(),
    meta: TemplateMetaSchema,
  })
  .strict();
export type Faction = z.infer<typeof FactionSchema>;

export const GameEventKindSchema = z.enum([
  "historical_fixed",
  "historical_conditional",
  "dynamic",
  "character",
  "regional",
  "disaster",
  "war",
  "court",
]);
export type GameEventKind = z.infer<typeof GameEventKindSchema>;

export const EventTriggerSchema = z
  .object({
    gameDate: z.iso.date().optional(),
    expression: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => Number(value.gameDate !== undefined) + Number(value.expression !== undefined) === 1,
    "事件触发器必须且只能包含 gameDate 或 expression",
  );
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

export const GameEventSchema = z
  .object({
    id: IdSchema,
    kind: GameEventKindSchema,
    trigger: EventTriggerSchema,
    effects: z.array(ModifierSchema).min(1),
    repeatable: z.boolean().optional(),
    meta: TemplateMetaSchema,
  })
  .strict();
export type GameEvent = z.infer<typeof GameEventSchema>;

export const EventChainStepSchema = z
  .object({
    eventId: IdSchema,
    branches: z.record(IdSchema, IdSchema).optional(),
  })
  .strict();
export type EventChainStep = z.infer<typeof EventChainStepSchema>;

export const EventChainSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    steps: z.array(EventChainStepSchema).min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type EventChain = z.infer<typeof EventChainSchema>;

export const RulePackSchema = z
  .object({
    packId: IdSchema,
    description: z.string().trim().min(1),
    modifiers: z.array(ModifierSchema).min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type RulePack = z.infer<typeof RulePackSchema>;

export const WorldbookEntrySchema = z
  .object({
    keys: z.array(z.string().trim().min(1)).min(1),
    content: z.string().trim().min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type WorldbookEntry = z.infer<typeof WorldbookEntrySchema>;

export const WorldbookSchema = z
  .object({
    id: IdSchema,
    description: z.string().trim().min(1),
    entries: z.array(WorldbookEntrySchema).min(1),
    meta: TemplateMetaSchema,
  })
  .strict();
export type Worldbook = z.infer<typeof WorldbookSchema>;
