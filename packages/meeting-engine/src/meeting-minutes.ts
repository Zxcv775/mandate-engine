import {
  MeetingMinutesSchema,
  type CharacterMemoryCandidate,
  type MeetingMinutes,
  type MeetingOutcomeCandidate,
  type MeetingSessionState,
  type MeetingTurnRecord,
} from "@mandate/domain";

/**
 * 会议纪要与会议记忆（§15/§16，规则生成，不经 LLM）。
 * 红线：每一项引用 sourceTurnIds；不新增 Transcript 中不存在的事实；
 * 私密内容不入公开纪要；不同参与者按其实际可见回合获得不同记忆。
 */

function excerpt(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface MinutesGenerationInput {
  readonly session: MeetingSessionState;
  readonly turns: readonly MeetingTurnRecord[];
  readonly outcomes: readonly MeetingOutcomeCandidate[];
  readonly deferredAgendaItemIds: readonly string[];
  readonly speakerLabels: Readonly<Record<string, string>>;
  readonly stateRevision: number;
  readonly createdAt: string;
  readonly idFactory: () => string;
}

export interface MinutesGenerationResult {
  readonly official: MeetingMinutes;
  readonly privateMinutes?: MeetingMinutes;
}

/** 正式纪要（公开层）+ 私密记录（private/sealed 回合，按参与者授权） */
export function generateMeetingMinutes(input: MinutesGenerationInput): MinutesGenerationResult {
  const { session, turns } = input;
  const label = (id: string) => input.speakerLabels[id] ?? id;

  const publicTurns = turns.filter(
    (turn) => turn.visibility === "court" || turn.visibility === "meeting",
  );
  const confidentialTurns = turns.filter(
    (turn) => turn.visibility === "private" || turn.visibility === "sealed",
  );
  const acceptedOutcomes = input.outcomes.filter((outcome) => outcome.status === "accepted");

  const official = MeetingMinutesSchema.parse({
    minutesId: `minutes_${input.idFactory()}`,
    meetingId: session.meetingId,
    saveId: session.saveId,
    kind: "official",
    audienceCharacterIds: [],
    title: `${session.title}·正式纪要`,
    participantIds: [...session.participantIds],
    entries: [
      ...publicTurns.map((turn) => ({
        text: `${label(turn.speakerId)}：${excerpt(turn.publicText)}`,
        sourceTurnIds: [turn.turnId],
      })),
      ...acceptedOutcomes.map((outcome) => ({
        text: `圣裁准行：${outcome.title}`,
        sourceTurnIds: [...outcome.sourceTurnIds],
      })),
    ],
    acceptedOutcomeCandidateIds: acceptedOutcomes.map((o) => o.outcomeCandidateId),
    deferredAgendaItemIds: [...input.deferredAgendaItemIds],
    stateRevision: input.stateRevision,
    createdAt: input.createdAt,
  });

  if (confidentialTurns.length === 0) {
    return { official };
  }
  const privateMinutes = MeetingMinutesSchema.parse({
    minutesId: `minutes_${input.idFactory()}`,
    meetingId: session.meetingId,
    saveId: session.saveId,
    kind: "private",
    // 私密层只授权给全程在场者
    audienceCharacterIds: [...session.participantIds],
    title: `${session.title}·密记`,
    participantIds: [...session.participantIds],
    entries: confidentialTurns.map((turn) => ({
      text: `${label(turn.speakerId)}：${excerpt(turn.publicText)}`,
      sourceTurnIds: [turn.turnId],
    })),
    acceptedOutcomeCandidateIds: [],
    deferredAgendaItemIds: [],
    stateRevision: input.stateRevision,
    createdAt: input.createdAt,
  });
  return { official, privateMinutes };
}

/**
 * 会议纪要记忆候选（§16）：按"该角色实际可见的回合"生成，
 * 不同参与者记住不同内容；未参会者不生成。
 */
export function buildMeetingSummaryMemoryCandidate(
  session: MeetingSessionState,
  visibleTurns: readonly MeetingTurnRecord[],
  acceptedOutcomes: readonly MeetingOutcomeCandidate[],
  speakerLabels: Readonly<Record<string, string>>,
): CharacterMemoryCandidate | undefined {
  if (visibleTurns.length === 0) return undefined;
  const label = (id: string) => speakerLabels[id] ?? id;
  const highlights = visibleTurns
    .filter((turn) => turn.type !== "agenda-transition")
    .slice(-3)
    .map((turn) => `${label(turn.speakerId)}言「${excerpt(turn.publicText, 40)}」`);
  const rulings = acceptedOutcomes.map((outcome) => `上准${excerpt(outcome.title, 30)}`);
  const content = excerpt([`与闻${session.title}`, ...highlights, ...rulings].join("；"), 480);
  return {
    type: "episodic",
    content,
    relatedCharacterIds: session.participantIds.filter((id) => id !== "emperor"),
    relatedEntityIds: [session.meetingId],
    topicTags: ["meeting", session.meetingId],
    sourceType: "official-record",
    confidence: 90,
    importance: session.type === "secret-council" ? 80 : 60,
    visibility: session.type === "secret-council" ? "private" : "self",
  };
}
