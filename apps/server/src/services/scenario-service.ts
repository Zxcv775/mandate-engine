import {
  ScenarioLoaderError,
  type DeepReadonly,
  type ScenarioBundle,
  type ScenarioLoader,
} from "@mandate/data-loader";
import type { ScenarioSummary } from "@mandate/domain";
import { ApiError } from "../errors/api-error";

function toSummary(bundle: DeepReadonly<ScenarioBundle>): ScenarioSummary {
  return {
    id: bundle.scenario.id,
    name: bundle.scenario.name,
    dynastyId: bundle.dynasty.id,
    dynastyName: bundle.dynasty.name,
    startGameDate: bundle.scenario.startGameDate,
    status: bundle.scenario.status,
    historicalDataCompleteness: bundle.scenario.historicalDataCompleteness,
    schemaValidated: true,
  };
}

function toApiError(error: unknown): never {
  if (error instanceof ScenarioLoaderError) {
    if (error.code === "SCENARIO_NOT_FOUND") {
      throw new ApiError(404, error.code, error.message);
    }

    throw new ApiError(500, error.code, "历史模板数据加载失败");
  }

  throw error;
}

export interface ScenarioService {
  list(): Promise<readonly ScenarioSummary[]>;
  get(scenarioId: string): Promise<ScenarioSummary>;
}

export function createScenarioService(loader: ScenarioLoader): ScenarioService {
  return {
    async list() {
      try {
        const scenarios = await loader.listScenarios();
        return await Promise.all(
          scenarios.map(async (scenario) =>
            toSummary(await loader.loadScenarioBundle(scenario.id)),
          ),
        );
      } catch (error) {
        return toApiError(error);
      }
    },

    async get(scenarioId) {
      try {
        return toSummary(await loader.loadScenarioBundle(scenarioId));
      } catch (error) {
        return toApiError(error);
      }
    },
  };
}
