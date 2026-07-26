import { ENGINE_INFO } from "@mandate/shared";
import type { FastifyInstance } from "fastify";
import { successResponse } from "./response";

export function registerVersionRoute(app: FastifyInstance): void {
  app.get("/api/version", (request) => successResponse(request, ENGINE_INFO));
}
