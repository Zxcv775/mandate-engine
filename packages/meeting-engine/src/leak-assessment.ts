import { SeededRng } from "@mandate/shared";
import {
  DEFAULT_MEETING_RULES,
  MeetingLeakAssessmentSchema,
  type CharacterTemplate,
  type GameState,
  type MeetingAgendaItem,
  type MeetingLeakAssessment,
  type MeetingSessionState,
} from "@mandate/domain";
import { fnv1a } from "./speaker-scheduler";

/**
 * 秘密会议泄密风险评估（§17，ADR-021）。
 * 完全确定性：规则评分 + SeededRng 确定性 roll；不由 LLM 决定任何随机结果。
 * 触发只产生候选事件 id（由 meeting.conclude 命令写入 hidden 队列），
 * 不在 Phase 4 展开事件后果。
 */

export interface LeakAssessmentInput {
  readonly session: MeetingSessionState;
  readonly agenda: readonly MeetingAgendaItem[];
  readonly state: GameState;
  readonly templates: readonly CharacterTemplate[];
  readonly createdAt: string;
}

const RISK_LEVELS: readonly {
  readonly level: MeetingLeakAssessment["riskLevel"];
  readonly min: number;
}[] = [
  { level: "critical", min: 80 },
  { level: "high", min: 60 },
  { level: "moderate", min: 40 },
  { level: "low", min: 20 },
  { level: "minimal", min: 0 },
];

export function assessMeetingLeak(input: LeakAssessmentInput): MeetingLeakAssessment {
  const { session, state } = input;
  const factors: string[] = [];
  const meetingRuleKey =
    session.type === "court-assembly"
      ? "court_assembly"
      : session.type === "imperial-council"
        ? "imperial_council"
        : "secret_council";
  const baseProbability = DEFAULT_MEETING_RULES[meetingRuleKey].baseLeakProbability;
  let score = Math.round(baseProbability * 30);
  factors.push(`会议类型基准（${session.type}）+${score}`);

  const participantCount = session.participantIds.length;
  const participantScore = Math.min(participantCount * 4, 24);
  score += participantScore;
  factors.push(`与闻者 ${participantCount} 人 +${participantScore}`);

  const sealedAgendaCount = input.agenda.filter(
    (item) => item.visibility === "sealed" || item.visibility === "private",
  ).length;
  if (sealedAgendaCount > 0) {
    const sealedScore = sealedAgendaCount * 8;
    score += sealedScore;
    factors.push(`机密议题 ${sealedAgendaCount} 项 +${sealedScore}`);
  }

  // 参与者人格与处境：谨慎降低风险；忠诚低/压力高提高风险；政敌在场提高风险
  const templateById = new Map(input.templates.map((template) => [template.id, template]));
  for (const characterId of session.participantIds) {
    if (characterId === "emperor") continue;
    const template = templateById.get(characterId);
    const runtime = state.characters[characterId];
    if (!template || !runtime) continue;
    const caution = template.personality.caution;
    if (caution >= 70) {
      score -= 4;
      factors.push(`${template.name} 谨慎 -4`);
    } else if (caution <= 30) {
      score += 4;
      factors.push(`${template.name} 疏于口风 +4`);
    }
    if (runtime.loyaltyToEmperor <= 40) {
      score += 5;
      factors.push(`${template.name} 忠诚可虑 +5`);
    }
    if (runtime.stress >= 70) {
      score += 3;
      factors.push(`${template.name} 心绪不宁 +3`);
    }
    const enemiesPresent = template.politicalProfile.politicalEnemies.length > 0;
    const rivalInRoom = session.participantIds.some(
      (otherId) =>
        otherId !== characterId &&
        template.initialRelations.some(
          (relation) =>
            relation.targetCharacterId === otherId &&
            (relation.kind === "enemy" || relation.kind === "rival"),
        ),
    );
    if (enemiesPresent && rivalInRoom) {
      score += 6;
      factors.push(`${template.name} 政敌在座 +6`);
    }
  }

  // 行政保密能力：行政效率越高，风声越紧
  const adminDampening = Math.round(state.country.administrativeCapacity / 10);
  score -= adminDampening;
  factors.push(`行政保密能力 -${adminDampening}`);

  score = Math.max(0, Math.min(100, score));
  const riskLevel = RISK_LEVELS.find((entry) => score >= entry.min)!.level;

  // 确定性 roll：seed 由存档 rng seed + meetingId 派生；只有秘密议事才掷
  let deterministicRoll: MeetingLeakAssessment["deterministicRoll"];
  if (session.type === "secret-council") {
    const seedCursorBefore = state.rng.cursor;
    const rng = new SeededRng(
      (fnv1a(`${state.rng.seed}:${session.meetingId}:leak`) + seedCursorBefore) >>> 0,
    );
    const roll = rng.next();
    const threshold = score / 100;
    deterministicRoll = {
      seedCursorBefore,
      roll: Number(roll.toFixed(6)),
      threshold: Number(threshold.toFixed(6)),
      triggered: roll < threshold,
    };
  }

  // 潜在受众：未与会但与参与者有敌对关系的在朝人物
  const potentialAudienceIds = input.templates
    .filter(
      (template) =>
        !session.participantIds.includes(template.id) &&
        state.characters[template.id]?.status === "active" &&
        template.initialRelations.some(
          (relation) =>
            session.participantIds.includes(relation.targetCharacterId) &&
            (relation.kind === "enemy" || relation.kind === "rival"),
        ),
    )
    .map((template) => template.id)
    .sort((a, b) => a.localeCompare(b));

  return MeetingLeakAssessmentSchema.parse({
    meetingId: session.meetingId,
    saveId: session.saveId,
    riskScore: score,
    riskLevel,
    contributingFactors: factors,
    ...(deterministicRoll ? { deterministicRoll } : {}),
    potentialAudienceIds,
    createdAtRevision: state.revision,
    createdAt: input.createdAt,
  });
}
