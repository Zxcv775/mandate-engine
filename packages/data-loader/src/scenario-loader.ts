import type { TemplateMeta } from "@mandate/domain";
import { fileURLToPath } from "node:url";
import { DataValidationError, ScenarioLoaderError } from "./errors";
import { deepFreeze } from "./deep-freeze";
import type { DataCatalog, DeepReadonly, ScenarioBundle, ScenarioLoader } from "./types";
import { validateDataDirectory } from "./validator";

export interface CreateScenarioLoaderOptions {
  dataRoot?: string | URL;
}

const defaultDataRoot = fileURLToPath(new URL("../../../data/", import.meta.url));

function collectSourceIds(metas: readonly TemplateMeta[]): Set<string> {
  return new Set(metas.flatMap((meta) => meta.sourceIds));
}

class CachedScenarioLoader implements ScenarioLoader {
  private catalogPromise?: Promise<DataCatalog>;
  private readonly bundles = new Map<string, DeepReadonly<ScenarioBundle>>();

  constructor(private readonly dataRoot: string | URL) {}

  private catalog(): Promise<DataCatalog> {
    this.catalogPromise ??= validateDataDirectory(this.dataRoot);
    return this.catalogPromise;
  }

  async listScenarios() {
    const catalog = await this.catalog();
    return deepFreeze(structuredClone(catalog.scenarios));
  }

  async loadScenarioBundle(scenarioId: string): Promise<DeepReadonly<ScenarioBundle>> {
    const cached = this.bundles.get(scenarioId);
    if (cached) return cached;

    let catalog: DataCatalog;
    try {
      catalog = await this.catalog();
    } catch (error) {
      if (error instanceof DataValidationError) {
        throw new ScenarioLoaderError("DATA_SCHEMA_INVALID", error.message, error);
      }
      throw error;
    }

    const scenario = catalog.scenarios.find((value) => value.id === scenarioId);
    if (!scenario) {
      throw new ScenarioLoaderError("SCENARIO_NOT_FOUND", `场景 "${scenarioId}" 不存在`);
    }
    const dynasty = catalog.dynasties.find((value) => value.id === scenario.dynastyId);
    const pack = catalog.institutionPacks.find((value) => value.id === dynasty?.institutionPackId);
    if (!dynasty || !pack) {
      throw new ScenarioLoaderError("DATA_SCHEMA_INVALID", `场景 "${scenarioId}" 引用不完整`);
    }

    const characters = scenario.coreCharacterIds.map((id) =>
      catalog.characters.find((value) => value.id === id)!,
    );
    const factionIds = new Set(
      characters.flatMap((character) => character.politicalProfile.factionIds),
    );
    const factions = catalog.factions.filter((faction) => factionIds.has(faction.id));
    const sourceIds = collectSourceIds([
      scenario.meta,
      dynasty.meta,
      pack.meta,
      ...characters.map((value) => value.meta),
      ...factions.map((value) => value.meta),
      ...pack.institutions.map((value) => value.meta),
      ...pack.offices.map((value) => value.meta),
    ]);

    const bundle = deepFreeze(
      structuredClone({
        scenario,
        dynasty,
        characters,
        factions,
        institutions: pack.institutions,
        offices: pack.offices,
        historicalSources: catalog.historicalSources.filter((source) => sourceIds.has(source.id)),
      }),
    );
    this.bundles.set(scenarioId, bundle);
    return bundle;
  }

  clearCache(): void {
    this.catalogPromise = undefined;
    this.bundles.clear();
  }
}

export function createScenarioLoader(options: CreateScenarioLoaderOptions = {}): ScenarioLoader {
  return new CachedScenarioLoader(options.dataRoot ?? defaultDataRoot);
}

const sharedLoader = createScenarioLoader();

export function listScenarios() {
  return sharedLoader.listScenarios();
}

export function loadScenarioBundle(scenarioId: string) {
  return sharedLoader.loadScenarioBundle(scenarioId);
}

export function clearCache(): void {
  sharedLoader.clearCache();
}
