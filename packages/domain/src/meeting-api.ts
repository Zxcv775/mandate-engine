import { z } from "zod";
import {
  EngineMeetingTypeSchema,
  MeetingPlayerActionSchema,
  MeetingVisibilitySchema,
} from "./meeting-runtime";

/**
 * 会议 API 契约（Phase 4，§18）。
 * step/action/ruling 一律携带 expectedRevision + expectedMeetingVersion；
 * 普通 API 的 Transcript 投影不含 sealed/private 回合。
 */

const IdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+$/);

export const MeetingIdParamsSchema = z.object({ saveId: IdSchema, meetingId: IdSchema }).strict();

export const CreateMeetingRequestSchema = z
  .object({
    meetingId: IdSchema.optional(),
    type: EngineMeetingTypeSchema,
    title: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    participantIds: z.array(IdSchema).min(1).max(50),
    chairCharacterId: IdSchema.optional(),
    visibility: MeetingVisibilitySchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CreateMeetingRequest = z.infer<typeof CreateMeetingRequestSchema>;

export const AddAgendaRequestSchema = z
  .object({
    agendaItemId: IdSchema.optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    topicIds: z.array(IdSchema).max(10).optional(),
    relatedEntityIds: z.array(IdSchema).max(20).optional(),
    requiredOfficeIds: z.array(IdSchema).max(10).optional(),
    maxTurns: z.number().int().min(1).max(200).optional(),
    visibility: MeetingVisibilitySchema.optional(),
  })
  .strict();
export type AddAgendaRequest = z.infer<typeof AddAgendaRequestSchema>;

const StepBaseShape = {
  expectedRevision: z.number().int().nonnegative(),
  expectedMeetingVersion: z.number().int().nonnegative(),
  idempotencyKey: IdSchema.optional(),
};

export const MeetingStepRequestSchema = z.object(StepBaseShape).strict();
export type MeetingStepRequest = z.infer<typeof MeetingStepRequestSchema>;

export const MeetingActionRequestSchema = z
  .object({
    ...StepBaseShape,
    action: MeetingPlayerActionSchema,
  })
  .strict();
export type MeetingActionRequest = z.infer<typeof MeetingActionRequestSchema>;

export const MeetingRulingRequestSchema = z
  .object({
    ...StepBaseShape,
    agendaItemId: IdSchema,
    selectedOutcomeCandidateIds: z.array(IdSchema).max(10),
    text: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
export type MeetingRulingRequest = z.infer<typeof MeetingRulingRequestSchema>;

export const MeetingPauseRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(200).optional() })
  .strict();

export const MeetingTurnsQuerySchema = z
  .object({
    agendaItemId: IdSchema.optional(),
    speakerId: IdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type MeetingTurnsQuery = z.infer<typeof MeetingTurnsQuerySchema>;
