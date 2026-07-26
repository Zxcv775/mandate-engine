import {
  DEFAULT_MEETING_LIMITS,
  type CharacterRuntimeState,
  type MeetingAgendaItem,
  type MeetingParticipantState,
  type MeetingSessionState,
  type MeetingSessionStatus,
  type MeetingTurnRecord,
} from "@mandate/domain";
import type { SpeakerCandidateInput, SpeakerEligibilityInput } from "@mandate/meeting-engine";
import { FIXTURE_NOW, makeCharacterTemplate } from "./character-fixtures";

/** Phase 4 会议测试共享 Fixture（确定性、无网络）。 */

export function makeSession(
  status: MeetingSessionStatus = "in-progress",
  overrides: Partial<MeetingSessionState> = {},
): MeetingSessionState {
  return {
    meetingId: "meeting-1",
    saveId: "save_demo",
    type: "imperial-council",
    status,
    title: "御前会议",
    purpose: "议辽东事",
    createdAtRevision: 0,
    meetingVersion: 1,
    turnNumber: 0,
    participantIds: ["wei-zhongxian", "huang-liji"],
    chairCharacterId: "emperor",
    agendaItemIds: ["agenda-1"],
    currentAgendaItemId: "agenda-1",
    limits: DEFAULT_MEETING_LIMITS,
    usedTurns: 0,
    visibility: "meeting",
    outcomeCandidateIds: [],
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeParticipant(
  characterId: string,
  overrides: Partial<MeetingParticipantState> = {},
): MeetingParticipantState {
  return {
    meetingId: "meeting-1",
    characterId,
    role: "minister",
    attendance: "present",
    speakingRights: "normal",
    turnsSpoken: 0,
    requestedToSpeak: false,
    challengedCharacterIds: [],
    runtimeFlags: [],
    ...overrides,
  };
}

export function makeAgendaItem(
  overrides: Partial<MeetingAgendaItem> = {},
): MeetingAgendaItem {
  return {
    agendaItemId: "agenda-1",
    meetingId: "meeting-1",
    title: "如何处置魏忠贤",
    description: "议魏忠贤去留及厂卫善后",
    topicIds: ["chan-wei"],
    proposerId: "emperor",
    status: "discussing",
    priority: 50,
    sequence: 0,
    maxTurns: 24,
    usedTurns: 0,
    relatedEntityIds: ["wei-zhongxian"],
    requiredOfficeIds: [],
    visibility: "meeting",
    ...overrides,
  };
}

export function makeRuntime(
  characterId: string,
  overrides: Partial<CharacterRuntimeState> = {},
): CharacterRuntimeState {
  return {
    characterId,
    status: "active",
    officeId: null,
    favor: 0,
    loyaltyToEmperor: 50,
    stress: 0,
    lastUpdatedRevision: 0,
    sourceIds: [],
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<MeetingTurnRecord> = {}): MeetingTurnRecord {
  return {
    turnId: `turn-${overrides.turnNumber ?? 0}`,
    meetingId: "meeting-1",
    saveId: "save_demo",
    agendaItemId: "agenda-1",
    turnNumber: 0,
    type: "character-speech",
    speakerId: "wei-zhongxian",
    addressedCharacterIds: ["emperor"],
    publicText: "臣有本奏。",
    visibility: "meeting",
    stateRevision: 1,
    meetingVersion: 1,
    sourceTurnIds: [],
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function makeEligibilityInput(
  characterId: string,
  session: MeetingSessionState,
  overrides: Partial<SpeakerEligibilityInput> = {},
): SpeakerEligibilityInput {
  return {
    characterId,
    runtime: makeRuntime(characterId),
    participant: makeParticipant(characterId),
    session,
    agendaItem: makeAgendaItem(),
    topicAccess: "normal",
    emperorSelected: false,
    ...overrides,
  };
}

export function makeCandidate(
  characterId: string,
  session: MeetingSessionState,
  overrides: {
    eligibility?: Partial<SpeakerEligibilityInput>;
    personality?: { courage?: number; ambition?: number; caution?: number };
    specialistDomains?: string[];
    stanceDiversityBonus?: number;
  } = {},
): SpeakerCandidateInput {
  const template = makeCharacterTemplate({
    id: characterId,
    name: `人物${characterId}`,
    ...(overrides.specialistDomains
      ? {
          knowledgeProfile: {
            specialistDomains: overrides.specialistDomains,
            familiarRegions: [],
            informationChannels: [],
            accessLevels: [],
            commonBiases: [],
            blindSpots: [],
          },
        }
      : {}),
  });
  if (overrides.personality) {
    template.personality = { ...template.personality, ...overrides.personality };
  }
  return {
    eligibility: makeEligibilityInput(characterId, session, overrides.eligibility ?? {}),
    template,
    ...(overrides.stanceDiversityBonus === undefined
      ? {}
      : { stanceDiversityBonus: overrides.stanceDiversityBonus }),
  };
}
