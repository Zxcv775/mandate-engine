import { z } from "zod";
import { ModifierStateSchema } from "./modifier";
import { PolicyRuntimeStateSchema, PolicyTruthSchema, type PolicyRuntimeState } from "./policy";

export const GAME_STATE_SCHEMA_VERSION = 1;
/** Phase 5：政策生命周期 + Modifier + hidden.policyTruth（state-002 前向迁移） */
export const GAME_STATE_VERSION = 2;

const IdSchema = z.string().trim().min(1);
const SourceIdsSchema = z.array(IdSchema);
const NonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PercentageSchema = z.number().int().min(0).max(100);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const RngStateSchema = z
  .object({
    seed: z.string().min(1),
    cursor: z.number().int().min(0).max(0xffff_ffff),
  })
  .strict();
export type RngState = z.infer<typeof RngStateSchema>;

export const CountryRuntimeStateSchema = z
  .object({
    treasuryTaels: NonNegativeIntegerSchema,
    grainReserveShi: NonNegativeIntegerSchema,
    legitimacy: PercentageSchema,
    stability: PercentageSchema,
    administrativeCapacity: PercentageSchema,
    militaryReadiness: PercentageSchema,
    sourceIds: SourceIdsSchema,
  })
  .strict();
export type CountryRuntimeState = z.infer<typeof CountryRuntimeStateSchema>;

export const CharacterRuntimeStatusSchema = z.enum([
  "active",
  "dismissed",
  "imprisoned",
  "exiled",
  "dead",
]);
export type CharacterRuntimeStatus = z.infer<typeof CharacterRuntimeStatusSchema>;

export const CharacterRuntimeStateSchema = z
  .object({
    characterId: IdSchema,
    status: CharacterRuntimeStatusSchema,
    officeId: IdSchema.nullable(),
    favor: z.number().int().min(-100).max(100),
    loyaltyToEmperor: PercentageSchema,
    stress: PercentageSchema,
    lastUpdatedRevision: NonNegativeIntegerSchema,
    sourceIds: SourceIdsSchema,
  })
  .strict();
export type CharacterRuntimeState = z.infer<typeof CharacterRuntimeStateSchema>;

export const OfficeRuntimeStateSchema = z
  .object({
    officeId: IdSchema,
    holderCharacterId: IdSchema.nullable(),
    appointedAtRevision: NonNegativeIntegerSchema.nullable(),
    sourceIds: SourceIdsSchema,
  })
  .strict();
export type OfficeRuntimeState = z.infer<typeof OfficeRuntimeStateSchema>;

// Phase 5：政策运行态迁移至 ./policy.ts（11 态生命周期 + 进度/预算/来源全字段）；
// 旧 6 态形态经 state-002 前向迁移映射（save-system/state-migrations.ts）。
export { PolicyRuntimeStateSchema } from "./policy";
export type { PolicyRuntimeState } from "./policy";

export const RegionRuntimeStateSchema = z
  .object({
    regionId: IdSchema,
    population: NonNegativeIntegerSchema,
    stability: PercentageSchema,
    sourceIds: SourceIdsSchema,
  })
  .strict();
export type RegionRuntimeState = z.infer<typeof RegionRuntimeStateSchema>;

export const RuntimeMeetingTypeSchema = z.enum([
  "court-assembly",
  "imperial-council",
  "secret-council",
  "private-audience",
]);
export type RuntimeMeetingType = z.infer<typeof RuntimeMeetingTypeSchema>;

export const RuntimeMeetingStatusSchema = z.enum([
  "scheduled",
  "in-progress",
  "concluded",
  "cancelled",
  "leaked",
]);
export type RuntimeMeetingStatus = z.infer<typeof RuntimeMeetingStatusSchema>;

export const MeetingRuntimeStateSchema = z
  .object({
    meetingId: IdSchema,
    type: RuntimeMeetingTypeSchema,
    status: RuntimeMeetingStatusSchema,
    participantIds: z.array(IdSchema),
    startedAtRevision: NonNegativeIntegerSchema.optional(),
    concludedAtRevision: NonNegativeIntegerSchema.optional(),
    /** Phase 4：会议主持（最小投影可选字段，旧存档缺省兼容） */
    chairCharacterId: IdSchema.optional(),
    /** Phase 4：会议保密级别（影响角色视图过滤；缺省按会议类型推断） */
    visibility: z.enum(["court", "meeting", "private", "sealed"]).optional(),
    sourceIds: SourceIdsSchema,
  })
  .strict();
export type MeetingRuntimeState = z.infer<typeof MeetingRuntimeStateSchema>;

export const EventQueueStateSchema = z
  .object({
    pendingEventIds: z.array(IdSchema),
    processedEventIds: z.array(IdSchema),
  })
  .strict();
export type EventQueueState = z.infer<typeof EventQueueStateSchema>;

export const HiddenGameStateSchema = z
  .object({
    queuedEventIds: z.array(IdSchema),
    secretFlags: z.record(z.string(), JsonValueSchema),
    internalNotes: z.array(z.string()),
    undiscoveredInformation: z.record(z.string(), JsonValueSchema),
    /** Phase 5：政策真实执行态（玩家 API 只见奏报；仅 Debug 可读；safe_share 剥离） */
    policyTruth: z.record(IdSchema, PolicyTruthSchema),
  })
  .strict();
export type HiddenGameState = z.infer<typeof HiddenGameStateSchema>;

export const GameStateMetaSchema = z
  .object({
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    sourceIds: SourceIdsSchema,
    sourceCatalogPresent: z.boolean(),
    forkedFromRevision: NonNegativeIntegerSchema.optional(),
    importedPackageHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type GameStateMeta = z.infer<typeof GameStateMetaSchema>;

function recordKeysMatchIds<T extends Record<string, Record<string, unknown>>>(
  value: T,
  idKey: string,
): boolean {
  return Object.entries(value).every(([key, entity]) => entity[idKey] === key);
}

export const GameStateSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    stateVersion: z.number().int().positive(),
    saveId: IdSchema,
    scenarioId: IdSchema,
    dynastyId: IdSchema,
    revision: NonNegativeIntegerSchema,
    tick: NonNegativeIntegerSchema,
    currentDate: z.iso.date(),
    rng: RngStateSchema,
    country: CountryRuntimeStateSchema,
    characters: z.record(IdSchema, CharacterRuntimeStateSchema),
    offices: z.record(IdSchema, OfficeRuntimeStateSchema),
    policies: z.record(IdSchema, PolicyRuntimeStateSchema),
    regions: z.record(IdSchema, RegionRuntimeStateSchema),
    meetings: z.record(IdSchema, MeetingRuntimeStateSchema),
    /** Phase 5：统一 Modifier 运行态（ADR-024） */
    modifiers: z.record(IdSchema, ModifierStateSchema),
    eventQueue: EventQueueStateSchema,
    flags: z.record(z.string(), JsonValueSchema),
    hidden: HiddenGameStateSchema,
    meta: GameStateMetaSchema,
  })
  .strict()
  .superRefine((state, context) => {
    const records = [
      ["characters", state.characters, "characterId"],
      ["offices", state.offices, "officeId"],
      ["policies", state.policies, "policyId"],
      ["regions", state.regions, "regionId"],
      ["meetings", state.meetings, "meetingId"],
      ["modifiers", state.modifiers, "modifierId"],
    ] as const;
    for (const [path, record, idKey] of records) {
      if (!recordKeysMatchIds(record, idKey)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `记录键必须与 ${idKey} 一致`,
        });
      }
    }
  });
export type GameState = z.infer<typeof GameStateSchema>;

export type PlayerStateView = Omit<GameState, "hidden">;

export const PlayerStateViewSchema = z.custom<PlayerStateView>((value) => {
  if (!value || typeof value !== "object" || "hidden" in value) return false;
  return GameStateSchema.safeParse({
    ...(value as Record<string, unknown>),
    hidden: {
      queuedEventIds: [],
      secretFlags: {},
      internalNotes: [],
      undiscoveredInformation: {},
      policyTruth: {},
    },
  }).success;
}, "玩家状态视图无效");

export function toPlayerStateView(state: Readonly<GameState>): PlayerStateView {
  const cloned = structuredClone(state);
  const { hidden: _hidden, ...visible } = cloned;
  return visible;
}

export type LlmVisibleGameState = PlayerStateView;

export function toLlmVisibleGameState(state: Readonly<GameState>): LlmVisibleGameState {
  return toPlayerStateView(state);
}

/**
 * @deprecated Phase 2 的最小角色视图占位：未做知识过滤（暴露全部 policies/meetings）。
 * Phase 3 起使用 character-view.ts 的 CharacterStateView 与
 * agent-runtime 的 buildCharacterView（含可见性策略）。
 */
export interface BasicCharacterStateView {
  readonly characterId: string;
  readonly currentDate: string;
  readonly publicCountryState: Readonly<CountryRuntimeState>;
  readonly knownPolicies: readonly Readonly<PolicyRuntimeState>[];
  readonly knownMeetings: readonly Readonly<MeetingRuntimeState>[];
  readonly selfState: Readonly<CharacterRuntimeState>;
  readonly knownRelations: readonly never[];
  readonly sourceIds: readonly string[];
}

/** @deprecated 见 BasicCharacterStateView 说明 */
export function toCharacterStateView(
  state: Readonly<GameState>,
  characterId: string,
): BasicCharacterStateView {
  const selfState = state.characters[characterId];
  if (!selfState) throw new Error(`角色 "${characterId}" 不存在`);
  return structuredClone({
    characterId,
    currentDate: state.currentDate,
    publicCountryState: state.country,
    knownPolicies: Object.values(state.policies),
    knownMeetings: Object.values(state.meetings),
    selfState,
    knownRelations: [],
    sourceIds: [...new Set([...state.meta.sourceIds, ...selfState.sourceIds])],
  });
}

export type DebugStateView = GameState;

export function toDebugStateView(state: Readonly<GameState>): DebugStateView {
  return structuredClone(state);
}
