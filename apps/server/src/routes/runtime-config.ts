import type { FastifyInstance } from "fastify";
import { toPublicRuntimeConfig, type RuntimeConfig } from "../config/index";
import { successResponse } from "./response";

export function registerRuntimeConfigRoute(app: FastifyInstance, config: RuntimeConfig): void {
  app.get("/api/config/runtime", (request) =>
    successResponse(request, toPublicRuntimeConfig(config)),
  );
}
