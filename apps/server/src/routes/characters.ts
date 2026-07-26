import {
  CharacterIdParamsSchema,
  CharacterRespondRequestSchema,
  SaveIdParamsSchema,
} from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { CharacterService } from "../services/character-service";
import { successResponse } from "./response";

/**
 * 人物公开 API（§13）。
 * respond 不提交任何 GameState 变更；响应为公开投影，
 * 不含 internalAssessment / 记忆候选 / hidden state。
 */
export function registerCharacterRoutes(
  app: FastifyInstance,
  service: CharacterService,
): void {
  app.get("/api/saves/:saveId/characters", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    return successResponse(request, await service.listCharacters(saveId));
  });

  app.get("/api/saves/:saveId/characters/:characterId", async (request) => {
    const { saveId, characterId } = CharacterIdParamsSchema.parse(request.params);
    return successResponse(request, await service.getPublicProfile(saveId, characterId));
  });

  app.post("/api/saves/:saveId/characters/:characterId/respond", async (request) => {
    const { saveId, characterId } = CharacterIdParamsSchema.parse(request.params);
    const body = CharacterRespondRequestSchema.parse(request.body);
    const outcome = await service.respond(saveId, characterId, body, request.id);
    return successResponse(request, outcome.response);
  });
}
