import type {
  Character,
  Dynasty,
  Faction,
  GameEvent,
  HistoricalSource,
  Institution,
  InstitutionPack,
  Office,
  RulePack,
  Scenario,
  Worldbook,
} from "@mandate/domain";

export interface DataCatalog {
  historicalSources: HistoricalSource[];
  dynasties: Dynasty[];
  scenarios: Scenario[];
  characters: Character[];
  factions: Faction[];
  institutionPacks: InstitutionPack[];
  events: GameEvent[];
  rulePacks: RulePack[];
  worldbooks: Worldbook[];
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface ScenarioBundle {
  scenario: Scenario;
  dynasty: Dynasty;
  characters: Character[];
  factions: Faction[];
  institutions: Institution[];
  offices: Office[];
  historicalSources: HistoricalSource[];
}

export interface ScenarioLoader {
  listScenarios(): Promise<readonly DeepReadonly<Scenario>[]>;
  loadScenarioBundle(scenarioId: string): Promise<DeepReadonly<ScenarioBundle>>;
  clearCache(): void;
}
