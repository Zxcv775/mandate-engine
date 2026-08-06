import { PolicyIdParamsSchema, SaveIdOnlyParamsSchema } from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { PolicyService } from "../services/policy-service";
import { successResponse } from "./response";

/**
 * 政策 Debug API（§12.2）：真实执行态 / 逐 tick 规则命中 / 规则清单。
 * 仅 config.debug.apiEnabled 时注册（生产 404，测试覆盖）。
 */
export function registerDebugPolicyRoutes(app: FastifyInstance, service: PolicyService): void {
  app.get("/api/debug/saves/:saveId/policies/:policyId/truth", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    return successResponse(request, await service.debugTruth(saveId, policyId));
  });

  app.get("/api/debug/saves/:saveId/policies/:policyId/rule-trace", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    return successResponse(request, await service.debugRuleTrace(saveId, policyId));
  });

  app.get("/api/debug/saves/:saveId/rules", async (request) => {
    const { saveId } = SaveIdOnlyParamsSchema.parse(request.params);
    return successResponse(request, await service.debugRules(saveId));
  });
}
