import { VersionResponseSchema, type VersionData } from "@mandate/domain";
import { apiClient, type ApiClient } from "./client";

export async function getVersion(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<VersionData> {
  return (await client.get("/api/version", VersionResponseSchema, signal)).data;
}
