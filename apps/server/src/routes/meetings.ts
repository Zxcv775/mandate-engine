import {
  AddAgendaRequestSchema,
  CreateMeetingRequestSchema,
  MeetingActionRequestSchema,
  MeetingCancelRequestSchema,
  MeetingIdParamsSchema,
  MeetingPauseRequestSchema,
  MeetingRulingRequestSchema,
  MeetingStepRequestSchema,
  MeetingTurnsQuerySchema,
  SaveIdParamsSchema,
} from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import type { MeetingService } from "../services/meeting-service";
import { successResponse } from "./response";

/**
 * 会议公开 API（§18）。
 * step/action/ruling 全部要求 expectedRevision + expectedMeetingVersion（stale → 409）；
 * Transcript 普通投影不含 sealed/private 回合；内部评估与泄密评估仅 Debug API。
 */
export function registerMeetingRoutes(app: FastifyInstance, service: MeetingService): void {
  app.post("/api/saves/:saveId/meetings", async (request, reply) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    const body = CreateMeetingRequestSchema.parse(request.body);
    const session = await service.createMeeting(saveId, {
      ...(body.meetingId === undefined ? {} : { meetingId: body.meetingId }),
      type: body.type,
      title: body.title,
      purpose: body.purpose,
      participantIds: body.participantIds,
      ...(body.chairCharacterId === undefined ? {} : { chairCharacterId: body.chairCharacterId }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      expectedRevision: body.expectedRevision,
    });
    return reply.code(201).send(successResponse(request, session));
  });

  app.get("/api/saves/:saveId/meetings", async (request) => {
    const { saveId } = SaveIdParamsSchema.parse(request.params);
    return successResponse(request, service.listMeetings(saveId));
  });

  app.get("/api/saves/:saveId/meetings/:meetingId", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    return successResponse(request, service.getMeeting(saveId, meetingId));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/agenda", async (request, reply) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = AddAgendaRequestSchema.parse(request.body);
    const item = await service.addAgendaItem(saveId, meetingId, body);
    return reply.code(201).send(successResponse(request, item));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/start", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingStepRequestSchema.parse(request.body);
    return successResponse(request, await service.startMeeting(saveId, meetingId, body));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/actions", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingActionRequestSchema.parse(request.body);
    return successResponse(request, await service.submitPlayerAction(saveId, meetingId, body));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/step", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingStepRequestSchema.parse(request.body);
    return successResponse(request, await service.step(saveId, meetingId, body));
  });

  app.get("/api/saves/:saveId/meetings/:meetingId/turns", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const query = MeetingTurnsQuerySchema.parse(request.query);
    const result = service.listTurns(saveId, meetingId, { ...query, includeConfidential: false });
    // 公开投影剥离 privateMetadata 与 providerTrace 细节
    return successResponse(request, {
      turns: result.turns.map(({ privateMetadata: _p, ...turn }) => turn),
      nextCursor: result.nextCursor,
    });
  });

  app.get("/api/saves/:saveId/meetings/:meetingId/outcomes", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    return successResponse(request, service.listOutcomes(saveId, meetingId));
  });

  app.get("/api/saves/:saveId/meetings/:meetingId/minutes", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    return successResponse(request, service.listMinutes(saveId, meetingId));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/rulings", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingRulingRequestSchema.parse(request.body);
    return successResponse(request, await service.issueRuling(saveId, meetingId, body));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/pause", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingPauseRequestSchema.parse(request.body ?? {});
    return successResponse(
      request,
      await service.pauseMeeting(saveId, meetingId, body.reason ?? "圣裁暂停"),
    );
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/resume", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    return successResponse(request, await service.resumeMeeting(saveId, meetingId));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/conclude", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingStepRequestSchema.parse(request.body);
    return successResponse(request, await service.concludeMeeting(saveId, meetingId, body));
  });

  app.post("/api/saves/:saveId/meetings/:meetingId/cancel", async (request) => {
    const { saveId, meetingId } = MeetingIdParamsSchema.parse(request.params);
    const body = MeetingCancelRequestSchema.parse(request.body);
    return successResponse(request, await service.cancelMeeting(saveId, meetingId, body));
  });
}
