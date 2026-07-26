import type { FastifyRequest } from "fastify";

export function successResponse<T>(request: FastifyRequest, data: T) {
  return {
    ok: true as const,
    data,
    meta: { requestId: request.id },
  };
}
