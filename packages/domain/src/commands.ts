import { z } from "zod";

const IdSchema = z.string().trim().min(1);

export const CommandActorSchema = z
  .object({
    type: z.enum(["player", "system", "migration", "import"]),
    id: IdSchema,
  })
  .strict();
export type CommandActor = z.infer<typeof CommandActorSchema>;

const CommandBaseShape = {
  commandId: IdSchema,
  saveId: IdSchema,
  baseRevision: z.number().int().nonnegative(),
  actor: CommandActorSchema,
  idempotencyKey: IdSchema.optional(),
  createdAt: z.iso.datetime(),
};

export const CountryResourceNameSchema = z.enum([
  "treasuryTaels",
  "grainReserveShi",
  "legitimacy",
  "stability",
  "administrativeCapacity",
  "militaryReadiness",
]);
export type CountryResourceName = z.infer<typeof CountryResourceNameSchema>;

export const GameCreateCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("game.create"),
    payload: z
      .object({
        scenarioId: IdSchema,
        title: z.string().trim().min(1).max(120),
        seed: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const CountryAdjustResourceCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("country.adjust-resource"),
    payload: z
      .object({
        resource: CountryResourceNameSchema,
        delta: z
          .number()
          .int()
          .refine((value) => value !== 0, "调整量不得为零"),
        reason: z.string().trim().min(1),
        sourceIds: z.array(IdSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const CharacterAssignOfficeCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("character.assign-office"),
    payload: z
      .object({
        characterId: IdSchema,
        officeId: IdSchema.nullable(),
        reason: z.string().trim().min(1).optional(),
        sourceIds: z.array(IdSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const TimeAdvanceCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("time.advance"),
    payload: z.object({ days: z.number().int().min(1).max(365) }).strict(),
  })
  .strict();

/**
 * Phase 4 会议生命周期命令（ADR-015）：
 * 只有会议的创建/开始/结束/取消进入 GameState（最小投影 + revision + StateChangeLog）；
 * 会议内部推进（回合/议程/发言者）在 SQLite meeting_sessions 以 meetingVersion 乐观锁管理。
 */
export const MeetingCreateCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("meeting.create"),
    payload: z
      .object({
        meetingId: IdSchema,
        meetingType: z.enum(["court-assembly", "imperial-council", "secret-council"]),
        participantIds: z.array(IdSchema).min(1),
        chairCharacterId: IdSchema,
        visibility: z.enum(["court", "meeting", "private", "sealed"]),
        reason: z.string().trim().min(1).optional(),
        sourceIds: z.array(IdSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const MeetingStartCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("meeting.start"),
    payload: z
      .object({
        meetingId: IdSchema,
        reason: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const MeetingConcludeCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("meeting.conclude"),
    payload: z
      .object({
        meetingId: IdSchema,
        /** 确定性泄密评估触发的候选事件（写入 hidden.queuedEventIds，sealed） */
        leakEventCandidateIds: z.array(IdSchema).optional(),
        reason: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const MeetingCancelCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("meeting.cancel"),
    payload: z
      .object({
        meetingId: IdSchema,
        reason: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * Phase 5 政策生命周期命令（ADR-023）：
 * 全部经 StateEngine 白名单提交（Zod + 引擎双重校验，恰好 revision+1 + StateChangeLog）。
 * LLM 不得发起——actor 为 player（直诏/御批）或 system:meeting-director（会议裁决映射）。
 */
const PolicyResourceBundleSchema = z
  .object({
    treasuryTaels: z.number().int().nonnegative().optional(),
    grainReserveShi: z.number().int().nonnegative().optional(),
  })
  .strict();

export const PolicyProposeCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.propose"),
    payload: z
      .object({
        policyId: IdSchema,
        templateId: IdSchema,
        /** 会议来源（裁决映射）或直诏 */
        origin: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("meeting"),
              meetingId: IdSchema,
              outcomeCandidateId: IdSchema,
            })
            .strict(),
          z.object({ kind: z.literal("direct-decree") }).strict(),
        ]),
        reason: z.string().trim().min(1).optional(),
        sourceIds: z.array(IdSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const PolicyApproveCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.approve"),
    payload: z
      .object({
        policyId: IdSchema,
        /** 直诏合法性检查结果（引擎侧再算一遍并核对，防伪造） */
        reason: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const PolicyRejectCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.reject"),
    payload: z
      .object({
        policyId: IdSchema,
        reason: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const PolicyIssueCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.issue"),
    payload: z
      .object({
        policyId: IdSchema,
        responsibleInstitutionId: IdSchema,
        responsibleCharacterIds: z.array(IdSchema).min(1).max(5),
        /** 追加预算（在模板启动成本之外；可为空对象） */
        additionalBudget: PolicyResourceBundleSchema.optional(),
        reason: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const PolicyAdjustCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.adjust"),
    payload: z
      .object({
        policyId: IdSchema,
        /** 追加预算 / 更换负责人，至少提供一项 */
        additionalBudget: PolicyResourceBundleSchema.optional(),
        responsibleCharacterIds: z.array(IdSchema).min(1).max(5).optional(),
        reason: z.string().trim().min(1),
      })
      .strict()
      .refine(
        (payload) =>
          payload.additionalBudget !== undefined || payload.responsibleCharacterIds !== undefined,
        "调整命令至少提供追加预算或负责人之一",
      ),
  })
  .strict();

export const PolicySuspendCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.suspend"),
    payload: z
      .object({
        policyId: IdSchema,
        reason: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const PolicyResumeCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.resume"),
    payload: z
      .object({
        policyId: IdSchema,
        reason: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const PolicyCancelCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.cancel"),
    payload: z
      .object({
        policyId: IdSchema,
        reason: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

/** 仅 Debug/测试：单独结算一个 tick（生产路径经 time.advance 钩子） */
export const PolicyResolveTickCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("policy.resolve-tick"),
    payload: z.object({ reason: z.string().trim().min(1).optional() }).strict(),
  })
  .strict();

export const CheckpointKindSchema = z.enum([
  "initial",
  "periodic",
  "manual",
  "pre_migration",
  "pre_import",
]);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

export const CheckpointCreateCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("checkpoint.create"),
    payload: z
      .object({
        kind: CheckpointKindSchema,
        label: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();

export const SaveRollbackCommandSchema = z
  .object({
    ...CommandBaseShape,
    commandType: z.literal("save.rollback"),
    payload: z
      .object({
        targetRevision: z.number().int().nonnegative(),
        mode: z.literal("logical"),
        dryRun: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const GameCommandSchema = z.discriminatedUnion("commandType", [
  GameCreateCommandSchema,
  CountryAdjustResourceCommandSchema,
  CharacterAssignOfficeCommandSchema,
  TimeAdvanceCommandSchema,
  CheckpointCreateCommandSchema,
  SaveRollbackCommandSchema,
  MeetingCreateCommandSchema,
  MeetingStartCommandSchema,
  MeetingConcludeCommandSchema,
  MeetingCancelCommandSchema,
  PolicyProposeCommandSchema,
  PolicyApproveCommandSchema,
  PolicyRejectCommandSchema,
  PolicyIssueCommandSchema,
  PolicyAdjustCommandSchema,
  PolicySuspendCommandSchema,
  PolicyResumeCommandSchema,
  PolicyCancelCommandSchema,
  PolicyResolveTickCommandSchema,
]);
export type GameCommand = z.infer<typeof GameCommandSchema>;
export type GameCreateCommand = z.infer<typeof GameCreateCommandSchema>;
export type CountryAdjustResourceCommand = z.infer<typeof CountryAdjustResourceCommandSchema>;
export type CharacterAssignOfficeCommand = z.infer<typeof CharacterAssignOfficeCommandSchema>;
export type TimeAdvanceCommand = z.infer<typeof TimeAdvanceCommandSchema>;
export type CheckpointCreateCommand = z.infer<typeof CheckpointCreateCommandSchema>;
export type SaveRollbackCommand = z.infer<typeof SaveRollbackCommandSchema>;
export type MeetingCreateCommand = z.infer<typeof MeetingCreateCommandSchema>;
export type MeetingStartCommand = z.infer<typeof MeetingStartCommandSchema>;
export type MeetingConcludeCommand = z.infer<typeof MeetingConcludeCommandSchema>;
export type MeetingCancelCommand = z.infer<typeof MeetingCancelCommandSchema>;
export type PolicyProposeCommand = z.infer<typeof PolicyProposeCommandSchema>;
export type PolicyApproveCommand = z.infer<typeof PolicyApproveCommandSchema>;
export type PolicyRejectCommand = z.infer<typeof PolicyRejectCommandSchema>;
export type PolicyIssueCommand = z.infer<typeof PolicyIssueCommandSchema>;
export type PolicyAdjustCommand = z.infer<typeof PolicyAdjustCommandSchema>;
export type PolicySuspendCommand = z.infer<typeof PolicySuspendCommandSchema>;
export type PolicyResumeCommand = z.infer<typeof PolicyResumeCommandSchema>;
export type PolicyCancelCommand = z.infer<typeof PolicyCancelCommandSchema>;
export type PolicyResolveTickCommand = z.infer<typeof PolicyResolveTickCommandSchema>;
