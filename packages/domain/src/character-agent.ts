import { z } from "zod";
import { CharacterMemoryCandidateSchema } from "./character-memory";

/**
 * Character Agent 输入/输出契约（Phase 3，ADR-014）。
 * 红线：
 * - Agent 输出只是发言、态度与候选：不是事实、不是已生效政策、不是状态变更；
 * - Agent 无状态写权限：不得修改 GameState / SQLite / StateChangeLog；
 *   候选行动须经 Application Service 与 State Engine 审批后才可能成为 Command；
 * - 输出必须通过本文件的 strict Schema 校验；修复次数受限，失败返回稳定错误；
 * - internalAssessment 默认不进入玩家 API，仅 Debug 模式可见。
 */

const IdSchema = z.string().trim().min(1);
const Score100Schema = z.number().int().min(0).max(100);

export const CharacterConversationModeSchema = z.enum([
  "private-audience",
  "court-assembly",
  "imperial-council",
  "secret-council",
  "memorial-response",
  "general",
]);
export type CharacterConversationMode = z.infer<typeof CharacterConversationModeSchema>;

export const CharacterAgentRequestSchema = z
  .object({
    saveId: IdSchema,
    characterId: IdSchema,
    mode: CharacterConversationModeSchema,
    input: z
      .object({
        speakerId: IdSchema,
        text: z.string().trim().min(1).max(4_000),
      })
      .strict(),
    participantIds: z.array(IdSchema).optional(),
    topic: z.string().trim().min(1).max(200).optional(),
    /** 发言必须基于的状态版本；head 已前进时返回 CHARACTER_CONTEXT_STALE */
    expectedRevision: z.number().int().nonnegative(),
    requestId: IdSchema.optional(),
  })
  .strict();
export type CharacterAgentRequest = z.infer<typeof CharacterAgentRequestSchema>;

export const StancePositionSchema = z.enum([
  "support",
  "oppose",
  "conditional",
  "neutral",
  "evasive",
  "uncertain",
]);
export type StancePosition = z.infer<typeof StancePositionSchema>;

export const CharacterStanceSchema = z
  .object({
    position: StancePositionSchema,
    confidence: Score100Schema,
    publicReasoning: z.array(z.string().trim().min(1)),
  })
  .strict();
export type CharacterStance = z.infer<typeof CharacterStanceSchema>;

export const CharacterEmotionSchema = z.enum([
  "calm",
  "concerned",
  "angry",
  "fearful",
  "confident",
  "guarded",
  "humiliated",
  "ambitious",
]);
export type CharacterEmotion = z.infer<typeof CharacterEmotionSchema>;

export const CharacterEmotionalStateSchema = z
  .object({
    primary: CharacterEmotionSchema,
    intensity: Score100Schema,
  })
  .strict();
export type CharacterEmotionalState = z.infer<typeof CharacterEmotionalStateSchema>;

export const ClaimBasisSchema = z.enum([
  "known",
  "reported",
  "suspected",
  "inferred",
  "rhetorical",
]);
export type ClaimBasis = z.infer<typeof ClaimBasisSchema>;

export const CharacterClaimSchema = z
  .object({
    claim: z.string().trim().min(1),
    basis: ClaimBasisSchema,
    confidence: Score100Schema,
    sourceIds: z.array(IdSchema),
  })
  .strict();
export type CharacterClaim = z.infer<typeof CharacterClaimSchema>;

export const CharacterProposedActionTypeSchema = z.enum([
  "recommend-policy",
  "recommend-appointment",
  "request-investigation",
  "request-audience",
  "request-information",
  "warn-risk",
  "decline-to-answer",
  "none",
]);
export type CharacterProposedActionType = z.infer<typeof CharacterProposedActionTypeSchema>;

/** 候选行动：仅是建议对象，不是 Mutation，不会自动执行 */
export const CharacterProposedActionSchema = z
  .object({
    type: CharacterProposedActionTypeSchema,
    summary: z.string().trim().min(1),
    targetEntityIds: z.array(IdSchema),
    rationale: z.array(z.string().trim().min(1)),
    confidence: Score100Schema,
  })
  .strict();
export type CharacterProposedAction = z.infer<typeof CharacterProposedActionSchema>;

export const CharacterInternalAssessmentSchema = z
  .object({
    privateConcerns: z.array(z.string().trim().min(1)),
    concealedIntentions: z.array(z.string().trim().min(1)),
  })
  .strict();
export type CharacterInternalAssessment = z.infer<typeof CharacterInternalAssessmentSchema>;

/**
 * 模型直接产出的结构化输出（不含系统补全的 characterId / trace）。
 * LLM 只需产出本对象；Agent 负责组装完整 CharacterAgentResult。
 */
export const CharacterAgentModelOutputSchema = z
  .object({
    speech: z.string().trim().min(1).max(4_000),
    stance: CharacterStanceSchema,
    internalAssessment: CharacterInternalAssessmentSchema.optional(),
    emotionalState: CharacterEmotionalStateSchema,
    claims: z.array(CharacterClaimSchema),
    proposedActions: z.array(CharacterProposedActionSchema),
    memoryCandidates: z.array(CharacterMemoryCandidateSchema),
    uncertaintyNotes: z.array(z.string().trim().min(1)),
  })
  .strict();
export type CharacterAgentModelOutput = z.infer<typeof CharacterAgentModelOutputSchema>;

export const CharacterAgentTraceSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersions: z.record(z.string(), z.string().min(1)),
    stateRevision: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    repaired: z.boolean(),
  })
  .strict();
export type CharacterAgentTrace = z.infer<typeof CharacterAgentTraceSchema>;

export const CharacterAgentResultSchema = CharacterAgentModelOutputSchema.extend({
  characterId: IdSchema,
  trace: CharacterAgentTraceSchema,
}).strict();
export type CharacterAgentResult = z.infer<typeof CharacterAgentResultSchema>;

/** 公开投影：默认对玩家 API 返回的内容；剥离内部评估、记忆候选与调用痕迹细节 */
export const CharacterPublicResponseSchema = z
  .object({
    characterId: IdSchema,
    speech: z.string().min(1),
    stance: CharacterStanceSchema,
    emotionalState: CharacterEmotionalStateSchema,
    claims: z.array(CharacterClaimSchema),
    proposedActions: z.array(CharacterProposedActionSchema),
    uncertaintyNotes: z.array(z.string().trim().min(1)),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CharacterPublicResponse = z.infer<typeof CharacterPublicResponseSchema>;

export function toCharacterPublicResponse(
  result: Readonly<CharacterAgentResult>,
): CharacterPublicResponse {
  return CharacterPublicResponseSchema.parse({
    characterId: result.characterId,
    speech: result.speech,
    stance: result.stance,
    emotionalState: result.emotionalState,
    claims: result.claims,
    proposedActions: result.proposedActions,
    uncertaintyNotes: result.uncertaintyNotes,
    stateRevision: result.trace.stateRevision,
  });
}

/** 对话记录：不是 GameState、不是世界事实，只是交互存证 */
export const CharacterConversationTurnSchema = z
  .object({
    turnId: IdSchema,
    saveId: IdSchema,
    characterId: IdSchema,
    speakerId: IdSchema,
    mode: CharacterConversationModeSchema,
    inputText: z.string().min(1),
    speech: z.string().min(1),
    stateRevision: z.number().int().nonnegative(),
    promptVersions: z.record(z.string(), z.string().min(1)),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type CharacterConversationTurn = z.infer<typeof CharacterConversationTurnSchema>;

export const ConsistencyViolationSeveritySchema = z.enum(["warning", "error"]);
export type ConsistencyViolationSeverity = z.infer<typeof ConsistencyViolationSeveritySchema>;

export const CharacterConsistencyReportSchema = z
  .object({
    passed: z.boolean(),
    violations: z.array(
      z
        .object({
          code: z.string().trim().min(1),
          severity: ConsistencyViolationSeveritySchema,
          message: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type CharacterConsistencyReport = z.infer<typeof CharacterConsistencyReportSchema>;
