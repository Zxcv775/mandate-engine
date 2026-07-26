import { HealthResponseSchema, type HealthData } from "@mandate/domain";
import { apiClient, type ApiClient } from "./client";

export async function getHealth(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<HealthData> {
  return (await client.get("/api/health", HealthResponseSchema, signal)).data;
}
