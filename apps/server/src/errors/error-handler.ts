import type { ApiErrorDetail, ApiErrorResponse } from "@mandate/domain";
import { ScenarioLoaderError } from "@mandate/data-loader";
import { CharacterAgentError } from "@mandate/agent-runtime";
import { LLMProviderError } from "@mandate/llm-adapters";
import { PromptBudgetExceededError } from "@mandate/prompt-system";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "./api-error";
import { redactSensitiveString, SaveSystemError } from "@mandate/save-system";
import { MeetingEngineError } from "@mandate/meeting-engine";
import { RuleEngineError } from "@mandate/rule-engine";
import { StateEngineError } from "@mandate/game-engine";

const CHARACTER_ERROR_STATUS: Record<CharacterAgentError["code"], number> = {
  CHARACTER_NOT_FOUND: 404,
  CHARACTER_NOT_AVAILABLE: 409,
  CHARACTER_CONTEXT_STALE: 409,
  CHARACTER_VIEW_BUILD_FAILED: 500,
  CHARACTER_MEMORY_INVALID: 422,
  CHARACTER_MEMORY_LIMIT_EXCEEDED: 409,
  CHARACTER_OUTPUT_INVALID: 502,
  CHARACTER_CONSISTENCY_FAILED: 502,
  PROMPT_BUDGET_EXCEEDED: 500,
  LLM_OUTPUT_REPAIR_FAILED: 502,
};

function errorResponse(
  request: FastifyRequest,
  code: ApiErrorResponse["error"]["code"],
  message: string,
  details?: readonly ApiErrorDetail[],
): ApiErrorResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details: [...details] }),
    },
    meta: { requestId: request.id },
  };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(errorResponse(request, "ROUTE_NOT_FOUND", "请求的 API 路由不存在"));
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply
        .code(413)
        .send(errorResponse(request, "REQUEST_BODY_TOO_LARGE", "请求体超过允许大小"));
    }
    if (error instanceof ZodError) {
      const details = error.issues.map<ApiErrorDetail>((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
        type: issue.code,
      }));
      return reply
        .code(400)
        .send(errorResponse(request, "VALIDATION_ERROR", "请求参数无效", details));
    }

    if (error instanceof ApiError) {
      request.log.warn({ code: error.code }, "预期 API 错误");
      return reply
        .code(error.statusCode)
        .send(
          errorResponse(request, error.code, redactSensitiveString(error.message), error.details),
        );
    }

    if (error instanceof ScenarioLoaderError) {
      request.log.warn({ code: error.code }, "预期场景加载错误");
      return reply
        .code(error.code === "SCENARIO_NOT_FOUND" ? 404 : 500)
        .send(
          errorResponse(
            request,
            error.code,
            error.code === "SCENARIO_NOT_FOUND"
              ? redactSensitiveString(error.message)
              : "历史模板数据加载失败",
          ),
        );
    }

    if (error instanceof MeetingEngineError) {
      request.log.warn({ code: error.code }, "预期会议引擎错误");
      const statusCode =
        error.code === "MEETING_NOT_FOUND" || error.code === "MEETING_AGENDA_NOT_FOUND" ? 404 : 409;
      return reply
        .code(statusCode)
        .send(errorResponse(request, error.code, redactSensitiveString(error.message)));
    }

    if (
      error instanceof StateEngineError &&
      (error.code === "MEETING_NOT_FOUND" ||
        error.code === "MEETING_INVALID_STATE" ||
        error.code === "MEETING_ALREADY_STARTED" ||
        error.code === "MEETING_ALREADY_CONCLUDED" ||
        error.code === "MEETING_PARTICIPANT_INVALID")
    ) {
      request.log.warn({ code: error.code }, "预期会议命令错误");
      return reply
        .code(error.code === "MEETING_NOT_FOUND" ? 404 : 409)
        .send(errorResponse(request, error.code, redactSensitiveString(error.message)));
    }

    if (
      error instanceof StateEngineError &&
      (error.code.startsWith("POLICY_") || error.code === "COMMAND_NOT_SUPPORTED")
    ) {
      request.log.warn({ code: error.code }, "预期政策命令错误");
      const statusCode =
        error.code === "POLICY_NOT_FOUND" || error.code === "POLICY_TEMPLATE_NOT_FOUND"
          ? 404
          : error.code === "POLICY_COST_INSUFFICIENT" ||
              error.code === "POLICY_ASSIGNEE_INVALID" ||
              error.code === "POLICY_LEGALITY_BLOCKED" ||
              error.code === "POLICY_NO_CHANGES"
            ? 422
            : 409;
      return reply
        .code(statusCode)
        .send(errorResponse(request, error.code as never, redactSensitiveString(error.message)));
    }

    if (error instanceof RuleEngineError) {
      request.log.warn({ code: error.code }, "预期规则引擎错误");
      const statusCode =
        error.code === "RULE_NOT_FOUND" || error.code === "MODIFIER_TARGET_NOT_FOUND" ? 404 : 422;
      return reply
        .code(statusCode)
        .send(errorResponse(request, error.code, redactSensitiveString(error.message)));
    }

    if (error instanceof CharacterAgentError) {
      request.log.warn({ code: error.code }, "预期人物 Agent 错误");
      return reply
        .code(CHARACTER_ERROR_STATUS[error.code] ?? 500)
        .send(errorResponse(request, error.code, redactSensitiveString(error.message)));
    }

    if (error instanceof PromptBudgetExceededError) {
      request.log.warn({ code: "PROMPT_BUDGET_EXCEEDED" }, "Prompt 超出预算");
      return reply
        .code(500)
        .send(errorResponse(request, "PROMPT_BUDGET_EXCEEDED", "人物上下文超出预算"));
    }

    if (error instanceof LLMProviderError) {
      request.log.warn({ provider: error.provider }, "LLM 供应商调用失败");
      return reply
        .code(502)
        .send(errorResponse(request, "PROVIDER_REQUEST_FAILED", "语言模型调用失败"));
    }

    if (error instanceof SaveSystemError) {
      const statusCode =
        error.code === "SAVE_NOT_FOUND" ||
        error.code === "MEETING_NOT_FOUND" ||
        error.code === "POLICY_NOT_FOUND" ||
        error.code === "POLICY_TEMPLATE_NOT_FOUND"
          ? 404
          : error.code === "SAVE_ALREADY_EXISTS" ||
              error.code === "SAVE_ARCHIVED" ||
              error.code === "STATE_REVISION_CONFLICT" ||
              error.code === "IDEMPOTENCY_KEY_CONFLICT" ||
              error.code === "ROLLBACK_TARGET_INVALID" ||
              error.code === "SAVE_VERSION_UNSUPPORTED" ||
              error.code === "MEETING_VERSION_STALE" ||
              error.code === "MEETING_AGENT_RESPONSE_DUPLICATE" ||
              error.code === "MEETING_INVALID_STATE" ||
              error.code === "MEETING_ALREADY_STARTED" ||
              error.code === "MEETING_ALREADY_CONCLUDED" ||
              error.code === "MEETING_PARTICIPANT_INVALID" ||
              error.code === "POLICY_STATUS_INVALID" ||
              error.code === "POLICY_TRANSITION_INVALID" ||
              error.code === "POLICY_ALREADY_DECIDED"
            ? 409
            : error.code === "POLICY_COST_INSUFFICIENT" ||
                error.code === "POLICY_ASSIGNEE_INVALID" ||
                error.code === "POLICY_LEGALITY_BLOCKED" ||
                error.code === "POLICY_NO_CHANGES"
              ? 422
              : error.code === "SAVE_PACKAGE_INVALID"
                ? 422
                : error.code === "DATABASE_ERROR" ||
                    error.code === "MIGRATION_FAILED" ||
                    error.code === "SAVE_IMPORT_FAILED" ||
                    error.code === "SAVE_EXPORT_FAILED" ||
                    error.code === "MEETING_TRANSCRIPT_WRITE_FAILED"
                  ? 500
                  : 400;
      request.log.warn({ code: error.code }, "预期存档 API 错误");
      return reply
        .code(statusCode)
        .send(errorResponse(request, error.code, redactSensitiveString(error.message)));
    }

    request.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "未处理的 API 异常",
    );
    return reply.code(500).send(errorResponse(request, "INTERNAL_ERROR", "服务器内部错误"));
  });
}
