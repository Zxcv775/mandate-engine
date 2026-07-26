import { z } from "zod";
import { PolicyLifecycleStatusSchema } from "./policy";

/**
 * 政策公开/Debug API 的请求 Schema（Phase 5，§12）。
 * 一切写操作要求 expectedRevision 乐观锁；玩家读到的是奏报视角，
 * 真实执行态（hidden.policyTruth）仅 Debug API 暴露。
 */

const IdSchema = z.string().trim().min(1);

export const SaveIdOnlyParamsSchema = z.object({ saveId: IdSchema }).strict();
export const PolicyIdParamsSchema = z.object({ saveId: IdSchema, policyId: IdSchema }).strict();

export const PolicyListQuerySchema = z
  .object({
    status: PolicyLifecycleStatusSchema.optional(),
  })
  .strict();
export type PolicyListQuery = z.infer<typeof PolicyListQuerySchema>;

const BudgetBundleSchema = z
  .object({
    treasuryTaels: z.number().int().nonnegative().optional(),
    grainReserveShi: z.number().int().nonnegative().optional(),
  })
  .strict();

/** 直诏 propose（POST /policies）；会议来源经裁决映射自动创建，不走本端点 */
export const ProposePolicyRequestSchema = z
  .object({
    policyId: IdSchema.optional(),
    templateId: IdSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ProposePolicyRequest = z.infer<typeof ProposePolicyRequestSchema>;

export const PolicyDecisionRequestSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type PolicyDecisionRequest = z.infer<typeof PolicyDecisionRequestSchema>;

export const IssuePolicyRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    responsibleInstitutionId: IdSchema,
    responsibleCharacterIds: z.array(IdSchema).min(1).max(5),
    additionalBudget: BudgetBundleSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type IssuePolicyRequest = z.infer<typeof IssuePolicyRequestSchema>;

export const AdjustPolicyRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    additionalBudget: BudgetBundleSchema.optional(),
    responsibleCharacterIds: z.array(IdSchema).min(1).max(5).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine(
    (payload) =>
      payload.additionalBudget !== undefined || payload.responsibleCharacterIds !== undefined,
    "至少提供追加预算或负责人之一",
  );
export type AdjustPolicyRequest = z.infer<typeof AdjustPolicyRequestSchema>;

export const PolicyLifecycleActionRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type PolicyLifecycleActionRequest = z.infer<typeof PolicyLifecycleActionRequestSchema>;

export const PolicyReportsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();
export type PolicyReportsQuery = z.infer<typeof PolicyReportsQuerySchema>;
