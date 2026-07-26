import {
  AdjustPolicyRequestSchema,
  IssuePolicyRequestSchema,
  PolicyDecisionRequestSchema,
  PolicyIdParamsSchema,
  PolicyLifecycleActionRequestSchema,
  PolicyListQuerySchema,
  PolicyReportsQuerySchema,
  ProposePolicyRequestSchema,
  SaveIdOnlyParamsSchema,
} from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { PolicyService } from "../services/policy-service";
import { successResponse } from "./response";

/**
 * 政策公开 API（§12.1）。
 * 全部写操作要求 expectedRevision（stale → 409）；玩家读到公开快照与公开奏报，
 * hidden 真实执行态仅 Debug 路由（生产 404）。
 */
export function registerPolicyRoutes(app: FastifyInstance, service: PolicyService): void {
  app.get("/api/saves/:saveId/policy-templates", async (request) => {
    const { saveId } = SaveIdOnlyParamsSchema.parse(request.params);
    return successResponse(request, await service.listTemplates(saveId));
  });

  app.get("/api/saves/:saveId/policies", async (request) => {
    const { saveId } = SaveIdOnlyParamsSchema.parse(request.params);
    const query = PolicyListQuerySchema.parse(request.query ?? {});
    return successResponse(request, await service.listPolicies(saveId, query.status));
  });

  app.get("/api/saves/:saveId/policies/:policyId", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    return successResponse(request, await service.getPolicy(saveId, policyId));
  });

  app.post("/api/saves/:saveId/policies", async (request, reply) => {
    const { saveId } = SaveIdOnlyParamsSchema.parse(request.params);
    const body = ProposePolicyRequestSchema.parse(request.body);
    return reply.code(201).send(successResponse(request, await service.propose(saveId, body)));
  });

  app.post("/api/saves/:saveId/policies/:policyId/decision", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = PolicyDecisionRequestSchema.parse(request.body);
    return successResponse(request, await service.decide(saveId, policyId, body));
  });

  app.post("/api/saves/:saveId/policies/:policyId/issue", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = IssuePolicyRequestSchema.parse(request.body);
    return successResponse(request, await service.issue(saveId, policyId, body));
  });

  app.post("/api/saves/:saveId/policies/:policyId/adjust", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = AdjustPolicyRequestSchema.parse(request.body);
    return successResponse(request, await service.adjust(saveId, policyId, body));
  });

  app.post("/api/saves/:saveId/policies/:policyId/suspend", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = PolicyLifecycleActionRequestSchema.parse(request.body);
    return successResponse(request, await service.suspend(saveId, policyId, body));
  });

  app.post("/api/saves/:saveId/policies/:policyId/resume", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = PolicyLifecycleActionRequestSchema.parse(request.body);
    return successResponse(request, await service.resume(saveId, policyId, body));
  });

  app.post("/api/saves/:saveId/policies/:policyId/cancel", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const body = PolicyLifecycleActionRequestSchema.parse(request.body);
    return successResponse(request, await service.cancel(saveId, policyId, body));
  });

  app.get("/api/saves/:saveId/policies/:policyId/reports", async (request) => {
    const { saveId, policyId } = PolicyIdParamsSchema.parse(request.params);
    const query = PolicyReportsQuerySchema.parse(request.query ?? {});
    return successResponse(request, await service.listReports(saveId, policyId, query));
  });
}
