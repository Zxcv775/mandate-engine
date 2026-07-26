import { z } from "zod";

/**
 * 三种会议类型。
 * 会议是不同的"规则环境"而非聊天背景（架构文档第 8 节）。
 */
export const MeetingTypeSchema = z.enum([
  "court_assembly", // 朝会
  "imperial_council", // 御前会议
  "secret_council", // 秘密议事
]);
export type MeetingType = z.infer<typeof MeetingTypeSchema>;

/**
 * 会议规则环境参数。
 * 影响：NPC 发言意愿与真实性、信息公开程度、政治风险、
 * 会议记录、泄密判定、政策合法性与执行阻力。
 */
export const MeetingRulesSchema = z.object({
  type: MeetingTypeSchema,
  maxParticipants: z.number().int().positive(),
  isPublic: z.boolean(),
  producesOfficialRecord: z.boolean(),
  /** 泄密基准概率 0-1（朝会天然公开 = 1.0） */
  baseLeakProbability: z.number().min(0).max(1),
  /** 在该类会议中形成的政策合法性修正系数 */
  legitimacyModifier: z.number(),
  /** NPC 发言真实性基准 0-1 */
  baseCandor: z.number().min(0).max(1),
  /** 政治风险基准 0-1（影响发言意愿与派系表态压力） */
  basePoliticalRisk: z.number().min(0).max(1),
});
export type MeetingRules = z.infer<typeof MeetingRulesSchema>;

/**
 * 三种会议的默认规则参数。
 * 初值为设计占位（gameplay-adjusted），Phase 9 统一平衡性调优。
 */
export const DEFAULT_MEETING_RULES: Record<MeetingType, MeetingRules> = {
  court_assembly: {
    type: "court_assembly",
    maxParticipants: 50,
    isPublic: true,
    producesOfficialRecord: true,
    baseLeakProbability: 1.0,
    legitimacyModifier: 1.2,
    baseCandor: 0.4,
    basePoliticalRisk: 0.8,
  },
  imperial_council: {
    type: "imperial_council",
    maxParticipants: 9,
    isPublic: false,
    producesOfficialRecord: true,
    baseLeakProbability: 0.3,
    legitimacyModifier: 1.0,
    baseCandor: 0.6,
    basePoliticalRisk: 0.5,
  },
  secret_council: {
    type: "secret_council",
    maxParticipants: 3,
    isPublic: false,
    producesOfficialRecord: false,
    baseLeakProbability: 0.15,
    legitimacyModifier: 0.7,
    baseCandor: 0.5,
    basePoliticalRisk: 0.6,
  },
};

export type MeetingParticipantRole = "chair" | "participant" | "observer";

/** 会议参与者（运行时） */
export interface MeetingParticipant {
  characterId: string;
  role: MeetingParticipantRole;
  hasSpoken: boolean;
  stance?: string;
}

export type MeetingStatus = "scheduled" | "in_progress" | "concluded" | "leaked";

/** 会议实例（运行时），rules 为召开时的规则环境快照 */
export interface Meeting {
  id: string;
  type: MeetingType;
  gameDate: string;
  topic: string;
  rules: MeetingRules;
  participants: MeetingParticipant[];
  status: MeetingStatus;
  /** 正式记录对应的 Memory id（producesOfficialRecord=true 时生成） */
  transcriptMemoryId?: string;
}
