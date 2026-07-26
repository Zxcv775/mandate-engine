import { ScenarioResponseSchema, type ScenarioSummary } from "@mandate/domain";
import { apiClient, type ApiClient } from "./client";

export async function getScenario(
  scenarioId: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<ScenarioSummary> {
  return (
    await client.get(
      `/api/scenarios/${encodeURIComponent(scenarioId)}`,
      ScenarioResponseSchema,
      signal,
    )
  ).data;
}
