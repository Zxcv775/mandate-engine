import {
  CharacterIdParamsSchema,
  CharacterMemoryQuerySchema,
  CharacterRespondRequestSchema,
} from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { CharacterService } from "../services/character-service";
import { successResponse } from "./response";

/**
 * 人物 Debug API：仅在 config.debug.apiEnabled 时注册（生产默认关闭 → 404）。
 * 不返回 API Key、完整系统 Prompt 与 sealed 记忆内容。
 */
export function registerDebugCharacterRoutes(
  app: FastifyInstance,
  service: CharacterService,
): void {
  app.get("/api/debug/saves/:saveId/characters/:characterId/context", async (request) => {
    const { saveId, characterId } = CharacterIdParamsSchema.parse(request.params);
    return successResponse(request, await service.debugContext(saveId, characterId));
  });

  app.get("/api/debug/saves/:saveId/characters/:characterId/memories", async (request) => {
    const { saveId, characterId } = CharacterIdParamsSchema.parse(request.params);
    const query = CharacterMemoryQuerySchema.parse(request.query);
    return successResponse(request, service.listMemoriesForDebug(saveId, characterId, query));
  });

  /** 带调试信息的 respond：额外返回一致性/预算/记忆选择摘要（仍不含完整 Prompt） */
  app.post(
    "/api/debug/saves/:saveId/characters/:characterId/respond",
    async (request) => {
      const { saveId, characterId } = CharacterIdParamsSchema.parse(request.params);
      const body = CharacterRespondRequestSchema.parse(request.body);
      const outcome = await service.respond(saveId, characterId, body, request.id);
      return successResponse(request, outcome);
    },
  );
}
