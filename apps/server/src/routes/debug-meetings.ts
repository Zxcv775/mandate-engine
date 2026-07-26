import { MeetingIdParamsSchema, MeetingTurnsQuerySchema } from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { MeetingService } from "../services/meeting-service";
import { successResponse } from "./response";

/**
 * 会议 Debug API：仅在 config.debug.apiEnabled 时注册（生产默认 404）。
 * 可见完整 Transcript（含 sealed/private 与 providerTrace）、泄密评估与私密纪要；
 * 仍不返回 API Key 与完整系统 Prompt。
 */
export function registerDebugMeetingRoutes(
  app: FastifyInstance,
  service: MeetingService,
): void {
  app.get("/api/debug/saves/:saveId/meetings/:meetingId/turns", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const query = MeetingTurnsQuerySchema.parse(request.query);
    return successResponse(
      request,
      service.listTurns(saveId, meetingId, { ...query, includeConfidential: true }),
    );
  });

  app.get("/api/debug/saves/:saveId/meetings/:meetingId/leak", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    return successResponse(request, service.getLeakAssessment(saveId, meetingId));
  });

  app.get("/api/debug/saves/:saveId/meetings/:meetingId/minutes", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    // Debug：返回全部纪要（含私密层）
    const officialAndPrivate = service
      .listMeetings(saveId)
      .filter((s) => s.meetingId === meetingId)
      .flatMap((s) => s.participantIds)
      .reduce<ReturnType<MeetingService["listMinutes"]>>(
        (all, characterId) => {
          for (const minutes of service.listMinutes(saveId, meetingId, characterId)) {
            if (!all.some((m) => m.minutesId === minutes.minutesId)) all.push(minutes);
          }
          return all;
        },
        [...service.listMinutes(saveId, meetingId)],
      );
    return successResponse(request, officialAndPrivate);
  });
}
