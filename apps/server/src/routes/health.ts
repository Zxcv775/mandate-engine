import type { FastifyInstance } from "fastify";
import { successResponse } from "./response";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/api/health", (request) =>
    successResponse(request, {
      status: "ok" as const,
      service: "mandate-server" as const,
      timestamp: new Date().toISOString(),
    }),
  );
}
