import {
  CountryResourceNameSchema,
  type GameCommand,
  type GameState,
  type MeetingOutcomeCandidate,
} from "@mandate/domain";
import { z } from "zod";

/**
 * Outcome → GameCommand 白名单映射（§14，ADR-019）。
 * LLM 只能提出候选；确定性代码负责校验目标实体、命令白名单与 Payload Schema。
 * Phase 4 仅支持映射到既有命令：country.adjust-resource / character.assign-office。
 * 无法映射的候选保留为会议建议（unsupported-command），绝不伪造命令、绝不 Patch 状态。
 */

export type OutcomeCommandMappingResult =
  | {
      readonly ok: true;
      readonly command: Omit<GameCommand, "commandId" | "baseRevision" | "createdAt" | "actor">;
    }
  | {
      readonly ok: false;
      readonly code: "MEETING_OUTCOME_UNSUPPORTED" | "MEETING_OUTCOME_INVALID";
      readonly reason: string;
    };

const AdjustResourcePreviewSchema = z
  .object({
    resource: CountryResourceNameSchema,
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0, "调整量不得为零"),
    reason: z.string().trim().min(1),
  })
  .strict();

const AssignOfficePreviewSchema = z
  .object({
    characterId: z.string().trim().min(1),
    officeId: z.string().trim().min(1).nullable(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/** Phase 5：政策立案预览（templateId 必须命中已装载模板） */
const ProposePolicyPreviewSchema = z
  .object({
    templateId: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/** 候选类型 → 允许的命令类型白名单（Phase 5 扩展 policy.propose） */
const SUPPORTED_COMMAND_TYPES = new Set([
  "country.adjust-resource",
  "character.assign-office",
  "policy.propose",
]);

export interface OutcomeMappingContext {
  /** 已装载的政策模板 ID 清单（policy.propose 候选校验用） */
  readonly policyTemplateIds?: readonly string[];
}

export function mapOutcomeToCommand(
  candidate: MeetingOutcomeCandidate,
  state: GameState,
  context: OutcomeMappingContext = {},
): OutcomeCommandMappingResult {
  if (!candidate.commandPreview || candidate.unsupportedCommand) {
    return {
      ok: false,
      code: "MEETING_OUTCOME_UNSUPPORTED",
      reason: "候选未附带可执行命令预览，保留为会议建议",
    };
  }
  const { commandType, payload } = candidate.commandPreview;
  if (!SUPPORTED_COMMAND_TYPES.has(commandType)) {
    return {
      ok: false,
      code: "MEETING_OUTCOME_UNSUPPORTED",
      reason: `命令类型不在白名单：${commandType}`,
    };
  }

  if (commandType === "policy.propose") {
    const parsed = ProposePolicyPreviewSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        code: "MEETING_OUTCOME_INVALID",
        reason: `政策立案 Payload 非法：${parsed.error.issues[0]?.message ?? "未知"}`,
      };
    }
    if (!(context.policyTemplateIds ?? []).includes(parsed.data.templateId)) {
      return {
        ok: false,
        code: "MEETING_OUTCOME_INVALID",
        reason: `政策模板不存在：${parsed.data.templateId}`,
      };
    }
    const policyId = `policy_${candidate.outcomeCandidateId.replace(/^outcome_/, "")}`;
    if (state.policies[policyId]) {
      return {
        ok: false,
        code: "MEETING_OUTCOME_INVALID",
        reason: `该候选已立案：${policyId}`,
      };
    }
    return {
      ok: true,
      command: {
        commandType: "policy.propose",
        saveId: state.saveId,
        payload: {
          policyId,
          templateId: parsed.data.templateId,
          origin: {
            kind: "meeting",
            meetingId: candidate.meetingId,
            outcomeCandidateId: candidate.outcomeCandidateId,
          },
          ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        },
      } as never,
    };
  }

  if (commandType === "country.adjust-resource") {
    const parsed = AdjustResourcePreviewSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        code: "MEETING_OUTCOME_INVALID",
        reason: `资源调整 Payload 非法：${parsed.error.issues[0]?.message ?? "未知"}`,
      };
    }
    // 预检余额下限：批准前即可提示（最终仍由 StateEngine + Schema 兜底）
    const current = state.country[parsed.data.resource];
    if (current + parsed.data.delta < 0) {
      return {
        ok: false,
        code: "MEETING_OUTCOME_INVALID",
        reason: `资源不足：${parsed.data.resource} 当前 ${current}，无法调整 ${parsed.data.delta}`,
      };
    }
    return {
      ok: true,
      command: {
        commandType: "country.adjust-resource",
        saveId: state.saveId,
        payload: parsed.data,
      } as never,
    };
  }

  const parsed = AssignOfficePreviewSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      code: "MEETING_OUTCOME_INVALID",
      reason: `任免 Payload 非法：${parsed.error.issues[0]?.message ?? "未知"}`,
    };
  }
  if (!state.characters[parsed.data.characterId]) {
    return {
      ok: false,
      code: "MEETING_OUTCOME_INVALID",
      reason: `目标人物不存在：${parsed.data.characterId}`,
    };
  }
  if (parsed.data.officeId !== null && !state.offices[parsed.data.officeId]) {
    return {
      ok: false,
      code: "MEETING_OUTCOME_INVALID",
      reason: `目标官职不存在：${parsed.data.officeId}`,
    };
  }
  return {
    ok: true,
    command: {
      commandType: "character.assign-office",
      saveId: state.saveId,
      payload: parsed.data,
    } as never,
  };
}
