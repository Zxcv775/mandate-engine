import { z } from "zod";
import { CharacterAgentModelOutputSchema } from "./character-agent";

/**
 * 会议中的人物输出契约（Phase 4，§11.2）。
 * 在 Phase 3 基础输出上追加：应对类型、面向对象、再发言意愿、
 * 议程可决建议与引用回合。referencedTurnIds 只能引用该角色可见的席间回合
 * （由一致性检查强制，ADR-014 补遗）。
 */

const IdSchema = z.string().trim().min(1);

export const MeetingResponseTypeSchema = z.enum([
  "speech",
  "answer",
  "rebuttal",
  "warning",
  "decline",
]);
export type MeetingResponseType = z.infer<typeof MeetingResponseTypeSchema>;

export const MeetingCharacterOutputSchema = CharacterAgentModelOutputSchema.extend({
  responseType: MeetingResponseTypeSchema,
  addressedCharacterIds: z.array(IdSchema),
  requestsToSpeakAgain: z.boolean(),
  suggestsAgendaResolution: z.boolean(),
  referencedTurnIds: z.array(IdSchema),
}).strict();
export type MeetingCharacterOutput = z.infer<typeof MeetingCharacterOutputSchema>;
