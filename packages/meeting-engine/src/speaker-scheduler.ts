import { SeededRng, fnv1a } from "@mandate/shared";
import type {
  CharacterTemplate,
  MeetingAgendaItem,
  MeetingParticipantState,
  MeetingSessionState,
} from "@mandate/domain";
import {
  evaluateSpeakerEligibility,
  type SpeakerEligibilityInput,
  type SpeakerEligibilityResult,
  type TopicAccessLevel,
} from "./speaker-eligibility";

/**
 * Speaker Scheduler（§9.2，确定性评分）。
 * 同分 tie-break 使用 SeededRng（seed = fnv1a(saveId+meetingId) + turnNumber），
 * 不触碰 GameState 的 rng cursor，禁止 Math.random（ADR-017）。
 */

export interface SpeakerCandidateInput {
  readonly eligibility: SpeakerEligibilityInput;
  readonly template?: CharacterTemplate;
  /** 立场多样性加分（由 service 从近期回合立场分布计算；缺省 0） */
  readonly stanceDiversityBonus?: number;
}

export interface SpeakerScoreBreakdown {
  readonly characterId: string;
  readonly total: number;
  readonly emperorSelected: number;
  readonly topicRelevance: number;
  readonly officeResponsibility: number;
  readonly requestedToSpeak: number;
  readonly challenged: number;
  readonly stanceDiversity: number;
  readonly urgency: number;
  readonly recentTurnPenalty: number;
  readonly turnCountPenalty: number;
  readonly silencePenalty: number;
  readonly knowledgePenalty: number;
}

export interface SpeakerSchedulingResult {
  readonly selected?: SpeakerScoreBreakdown;
  readonly rankings: readonly SpeakerScoreBreakdown[];
  readonly ineligible: readonly SpeakerEligibilityResult[];
  readonly tieBreakUsed: boolean;
}

/** 确定性字符串哈希（FNV-1a 32bit），为 tie-break 派生种子；实现下沉至 shared（Phase 5） */
export { fnv1a };

function scoreCandidate(
  candidate: SpeakerCandidateInput,
  session: MeetingSessionState,
  agendaItem: MeetingAgendaItem | undefined,
  challengedBy: ReadonlySet<string>,
): SpeakerScoreBreakdown {
  const { eligibility, template } = candidate;
  const participant = eligibility.participant as MeetingParticipantState;
  const runtime = eligibility.runtime;

  const emperorSelected = eligibility.emperorSelected ? 100 : 0;

  let topicRelevance = 0;
  if (template && agendaItem) {
    const domains = new Set(template.knowledgeProfile.specialistDomains);
    const matches = agendaItem.topicIds.filter((topic) => domains.has(topic)).length;
    topicRelevance = Math.min(matches * 15, 30);
  }

  const officeResponsibility =
    agendaItem && runtime?.officeId && agendaItem.requiredOfficeIds.includes(runtime.officeId)
      ? 25
      : 0;

  const requestedToSpeak = participant.requestedToSpeak ? 20 : 0;
  const challenged = challengedBy.has(eligibility.characterId) ? 15 : 0;
  const stanceDiversity = Math.max(0, Math.min(candidate.stanceDiversityBonus ?? 0, 15));

  const urgency = template
    ? Math.max(
        0,
        Math.min(
          Math.round((template.personality.courage + template.personality.ambition - 100) / 10),
          10,
        ),
      )
    : 0;

  const recentTurnPenalty =
    participant.lastSpokeAtTurn !== undefined &&
    session.turnNumber - participant.lastSpokeAtTurn <= 1
      ? 25
      : 0;
  const turnCountPenalty = participant.turnsSpoken * 4;
  const silencePenalty = template && template.personality.caution >= 70 ? 8 : 0;
  const knowledgePenalty = eligibility.topicAccess === "limited" ? 10 : 0;

  const total =
    emperorSelected +
    topicRelevance +
    officeResponsibility +
    requestedToSpeak +
    challenged +
    stanceDiversity +
    urgency -
    recentTurnPenalty -
    turnCountPenalty -
    silencePenalty -
    knowledgePenalty;

  return {
    characterId: eligibility.characterId,
    total,
    emperorSelected,
    topicRelevance,
    officeResponsibility,
    requestedToSpeak,
    challenged,
    stanceDiversity,
    urgency,
    recentTurnPenalty,
    turnCountPenalty,
    silencePenalty,
    knowledgePenalty,
  };
}

export function scheduleNextSpeaker(
  session: MeetingSessionState,
  agendaItem: MeetingAgendaItem | undefined,
  candidates: readonly SpeakerCandidateInput[],
): SpeakerSchedulingResult {
  const eligibilityResults = candidates.map((candidate) =>
    evaluateSpeakerEligibility(candidate.eligibility),
  );
  const ineligible = eligibilityResults.filter((result) => !result.eligible);
  const eligibleIds = new Set(
    eligibilityResults.filter((result) => result.eligible).map((result) => result.characterId),
  );

  // 被他人质疑者集合（他人 challengedCharacterIds 指向该人物）
  const challengedBy = new Set<string>();
  for (const candidate of candidates) {
    for (const target of candidate.eligibility.participant?.challengedCharacterIds ?? []) {
      challengedBy.add(target);
    }
  }

  const rankings = candidates
    .filter((candidate) => eligibleIds.has(candidate.eligibility.characterId))
    .map((candidate) => scoreCandidate(candidate, session, agendaItem, challengedBy))
    .sort((a, b) => b.total - a.total || a.characterId.localeCompare(b.characterId));

  if (rankings.length === 0) {
    return { rankings, ineligible, tieBreakUsed: false };
  }

  const topScore = rankings[0]!.total;
  const tied = rankings.filter((entry) => entry.total === topScore);
  if (tied.length === 1) {
    return { selected: tied[0]!, rankings, ineligible, tieBreakUsed: false };
  }
  // 确定性 tie-break：seed 由存档+会议派生，cursor 用 turnNumber 前进
  const rng = new SeededRng(
    (fnv1a(`${session.saveId}:${session.meetingId}`) + session.turnNumber) >>> 0,
  );
  const selected = tied[Math.floor(rng.next() * tied.length)]!;
  return { selected, rankings, ineligible, tieBreakUsed: true };
}

export type { TopicAccessLevel };
