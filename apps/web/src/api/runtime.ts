import {
  RuntimeConfigResponseSchema,
  type PublicRuntimeConfig,
} from "@mandate/domain";
import { apiClient, type ApiClient } from "./client";

export async function getRuntimeConfig(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PublicRuntimeConfig> {
  return (await client.get("/api/config/runtime", RuntimeConfigResponseSchema, signal)).data;
}
