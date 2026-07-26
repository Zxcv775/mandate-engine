import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ScenarioService } from "../services/scenario-service";
import { successResponse } from "./response";

const ScenarioParamsSchema = z
  .object({
    scenarioId: z.string().trim().min(1).regex(/^[a-z0-9-]+$/),
  })
  .strict();

export function registerScenarioRoutes(
  app: FastifyInstance,
  scenarioService: ScenarioService,
): void {
  app.get("/api/scenarios", async (request) => {
    return successResponse(request, await scenarioService.list());
  });

  app.get("/api/scenarios/:scenarioId", async (request) => {
    const { scenarioId } = ScenarioParamsSchema.parse(request.params);
    return successResponse(request, await scenarioService.get(scenarioId));
  });
}
