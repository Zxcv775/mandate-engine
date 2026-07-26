import {
  ApiResponseMetaSchema,
  CharacterListResponseSchema,
  CharacterProfileResponseSchema,
  CharacterPublicResponseSchema,
  CharacterRespondResponseSchema,
  type CharacterConversationMode,
} from "@mandate/domain";
import { z } from "zod";
import { apiClient } from "./client";

export interface RespondPayload {
  expectedRevision: number;
  mode: CharacterConversationMode;
  input: { speakerId: string; text: string };
  participantIds?: string[];
  topic?: string;
}

/** Debug respond：额外返回一致性/预算/记忆选择摘要（结构由服务端演进，宽松解析） */
const DebugRespondResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({
      response: CharacterPublicResponseSchema,
      debug: z.unknown(),
    }),
    meta: ApiResponseMetaSchema,
  })
  .strict();

const DebugContextResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.unknown(),
    meta: ApiResponseMetaSchema,
  })
  .strict();

export async function listCharacters(saveId: string, signal?: AbortSignal) {
  return (
    await apiClient.get(
      `/api/saves/${encodeURIComponent(saveId)}/characters`,
      CharacterListResponseSchema,
      signal,
    )
  ).data;
}

export async function getCharacterProfile(
  saveId: string,
  characterId: string,
  signal?: AbortSignal,
) {
  return (
    await apiClient.get(
      `/api/saves/${encodeURIComponent(saveId)}/characters/${encodeURIComponent(characterId)}`,
      CharacterProfileResponseSchema,
      signal,
    )
  ).data;
}

export async function respondCharacter(
  saveId: string,
  characterId: string,
  payload: RespondPayload,
  signal?: AbortSignal,
) {
  return (
    await apiClient.post(
      `/api/saves/${encodeURIComponent(saveId)}/characters/${encodeURIComponent(characterId)}/respond`,
      payload,
      CharacterRespondResponseSchema,
      signal,
    )
  ).data;
}

export async function respondCharacterWithDebug(
  saveId: string,
  characterId: string,
  payload: RespondPayload,
  signal?: AbortSignal,
) {
  return (
    await apiClient.post(
      `/api/debug/saves/${encodeURIComponent(saveId)}/characters/${encodeURIComponent(characterId)}/respond`,
      payload,
      DebugRespondResponseSchema,
      signal,
    )
  ).data;
}

export async function getDebugContext(
  saveId: string,
  characterId: string,
  signal?: AbortSignal,
) {
  return (
    await apiClient.get(
      `/api/debug/saves/${encodeURIComponent(saveId)}/characters/${encodeURIComponent(characterId)}/context`,
      DebugContextResponseSchema,
      signal,
    )
  ).data;
}
