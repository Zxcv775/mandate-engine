import {
  SaveChangesResponseSchema,
  SaveListResponseSchema,
  SaveStateResponseSchema,
} from "@mandate/domain";
import { apiClient } from "./client";

export async function listSaves(signal?: AbortSignal) {
  return (await apiClient.get("/api/saves?includeArchived=true", SaveListResponseSchema, signal))
    .data;
}

export async function getSaveState(saveId: string, signal?: AbortSignal) {
  return (
    await apiClient.get(
      `/api/saves/${encodeURIComponent(saveId)}/state`,
      SaveStateResponseSchema,
      signal,
    )
  ).data;
}

export async function getSaveChanges(saveId: string, signal?: AbortSignal) {
  return (
    await apiClient.get(
      `/api/saves/${encodeURIComponent(saveId)}/changes?limit=200`,
      SaveChangesResponseSchema,
      signal,
    )
  ).data;
}
