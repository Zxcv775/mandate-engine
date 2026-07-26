import {
  GAME_STATE_SCHEMA_VERSION,
  GAME_STATE_VERSION,
  GameStateSchema,
  type Character,
  type CountryRuntimeState,
  type Dynasty,
  type GameState,
  type HistoricalSource,
  type Institution,
  type Office,
  type Scenario,
} from "@mandate/domain";
import type { Clock } from "./clock";
import { sha256Hex } from "./stable-json";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface ScenarioInitializationBundle {
  readonly scenario: DeepReadonly<Scenario>;
  readonly dynasty: DeepReadonly<Dynasty>;
  readonly characters: readonly DeepReadonly<Character>[];
  readonly institutions: readonly DeepReadonly<Institution>[];
  readonly offices: readonly DeepReadonly<Office>[];
  readonly historicalSources: readonly DeepReadonly<HistoricalSource>[];
}

export interface CreateInitialGameStateInput {
  saveId: string;
  seed: string;
  country?: Partial<Omit<CountryRuntimeState, "sourceIds">>;
}

/** Phase 2 工程基线数值，属于 gameplay-adjusted 运行时默认值，不是史实断言。 */
export const DEFAULT_INITIAL_COUNTRY: Omit<CountryRuntimeState, "sourceIds"> = {
  treasuryTaels: 4_200_000,
  grainReserveShi: 2_000_000,
  legitimacy: 70,
  stability: 45,
  administrativeCapacity: 55,
  militaryReadiness: 40,
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function createInitialGameState(
  bundle: ScenarioInitializationBundle,
  input: CreateInitialGameStateInput,
  clock: Clock,
): GameState {
  const timestamp = clock.now().toISOString();
  const sourceIds = unique([
    ...bundle.scenario.meta.sourceIds,
    ...bundle.dynasty.meta.sourceIds,
    ...bundle.characters.flatMap((value) => value.meta.sourceIds),
    ...bundle.institutions.flatMap((value) => value.meta.sourceIds),
    ...bundle.offices.flatMap((value) => value.meta.sourceIds),
  ]);

  const state: GameState = {
    schemaVersion: GAME_STATE_SCHEMA_VERSION,
    stateVersion: GAME_STATE_VERSION,
    saveId: input.saveId,
    scenarioId: bundle.scenario.id,
    dynastyId: bundle.dynasty.id,
    revision: 0,
    tick: 0,
    currentDate: bundle.scenario.startGameDate,
    // 只持久化不可逆 seed 摘要，保持确定性且避免误把凭据写入存档。
    rng: { seed: sha256Hex(input.seed), cursor: 0 },
    country: {
      ...DEFAULT_INITIAL_COUNTRY,
      ...input.country,
      sourceIds: unique([...bundle.scenario.meta.sourceIds, ...bundle.dynasty.meta.sourceIds]),
    },
    characters: Object.fromEntries(
      bundle.characters.map((character) => [
        character.id,
        {
          characterId: character.id,
          status: character.identity.initialRuntimeStatus ?? ("active" as const),
          officeId: character.identity.initialOfficeId ?? null,
          favor: 0,
          loyaltyToEmperor: 50,
          stress: 0,
          lastUpdatedRevision: 0,
          sourceIds: [...character.meta.sourceIds],
        },
      ]),
    ),
    offices: Object.fromEntries(
      bundle.offices.map((office) => {
        const holder = bundle.characters.find(
          (character) => character.identity.initialOfficeId === office.id,
        );
        return [
          office.id,
          {
            officeId: office.id,
            holderCharacterId: holder?.id ?? null,
            appointedAtRevision: holder ? 0 : null,
            sourceIds: [...office.meta.sourceIds],
          },
        ];
      }),
    ),
    policies: {},
    regions: {},
    meetings: {},
    modifiers: {},
    eventQueue: { pendingEventIds: [], processedEventIds: [] },
    flags: {},
    hidden: {
      queuedEventIds: [],
      secretFlags: {},
      internalNotes: [],
      undiscoveredInformation: {},
      policyTruth: {},
    },
    meta: {
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceIds,
      sourceCatalogPresent: true,
    },
  };

  return GameStateSchema.parse(state);
}
