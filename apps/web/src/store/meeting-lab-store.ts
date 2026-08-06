import type { SaveMetadata } from "@mandate/domain";
import { createStore } from "zustand/vanilla";
import { ApiClientError } from "../api/client";
import { listCharacters } from "../api/characters";
import { getSaveState, listSaves } from "../api/saves";
import { listPolicyTemplates, type PolicyTemplateSummary } from "../api/policies";
import {
  addAgenda,
  cancelMeeting,
  concludeMeeting,
  createMeeting,
  getDebugLeak,
  getMeeting,
  issueRuling,
  listMeetings,
  listOutcomes,
  listTurns,
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  stepMeeting,
  submitAction,
  type MeetingSessionSummary,
  type MeetingTurnView,
  type OutcomeView,
  type StepResult,
} from "../api/meetings";

/** Meeting Lab 状态（开发者调试台）。所有推进携带 expectedRevision + expectedMeetingVersion。 */

export interface MeetingLabState {
  saves: readonly SaveMetadata[];
  selectedSaveId?: string;
  headRevision?: number;
  characters: readonly { characterId: string; name: string; availableForAudience: boolean }[];
  meetings: readonly MeetingSessionSummary[];
  session?: MeetingSessionSummary;
  agenda: readonly { agendaItemId: string; title: string; status: string }[];
  turns: readonly MeetingTurnView[];
  outcomes: readonly OutcomeView[];
  leak?: unknown;
  lastDecision?: string;
  busy: boolean;
  error?: string;
  // 创建表单
  newTitle: string;
  newType: string;
  newAgendaTitle: string;
  /** Phase 5：议程关联政策模板（人物可荐策映射为 policy.propose） */
  newAgendaTemplateId: string;
  policyTemplates: readonly PolicyTemplateSummary[];
  selectedParticipants: readonly string[];
  // 动作输入
  actionText: string;
  targetCharacterId?: string;

  refreshSaves(): Promise<void>;
  selectSave(saveId: string): Promise<void>;
  refreshMeeting(meetingId?: string): Promise<void>;
  setField(
    field: "newTitle" | "newType" | "newAgendaTitle" | "newAgendaTemplateId" | "actionText",
    value: string,
  ): void;
  toggleParticipant(characterId: string): void;
  setTarget(characterId?: string): void;
  create(): Promise<void>;
  start(): Promise<void>;
  step(): Promise<void>;
  act(action: Record<string, unknown>): Promise<void>;
  rule(agendaItemId: string, outcomeIds: string[]): Promise<void>;
  conclude(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  loadLeak(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : "未知错误";
}

export const meetingLabStore = createStore<MeetingLabState>()((set, get) => {
  async function refreshHead(saveId: string) {
    const state = await getSaveState(saveId);
    set({ headRevision: state.revision });
    return state.revision;
  }

  async function applyStep(result: StepResult) {
    const saveId = get().selectedSaveId!;
    await refreshHead(saveId);
    set({ session: result.session, lastDecision: `${result.decisionType}：${result.reason}` });
    await get().refreshMeeting(result.session.meetingId);
  }

  async function guarded(run: () => Promise<void>) {
    set({ busy: true, error: undefined });
    try {
      await run();
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      set({ busy: false });
    }
  }

  return {
    saves: [],
    characters: [],
    meetings: [],
    agenda: [],
    turns: [],
    outcomes: [],
    busy: false,
    newTitle: "御前会议·议处魏忠贤",
    newType: "imperial-council",
    newAgendaTitle: "如何处置魏忠贤",
    newAgendaTemplateId: "",
    policyTemplates: [],
    selectedParticipants: [],
    actionText: "众卿以为魏忠贤当如何处置？",

    async refreshSaves() {
      await guarded(async () => {
        set({ saves: await listSaves() });
      });
    },

    async selectSave(saveId) {
      await guarded(async () => {
        const [characters, meetings, policyTemplates] = await Promise.all([
          listCharacters(saveId),
          listMeetings(saveId),
          listPolicyTemplates(saveId),
        ]);
        set({
          selectedSaveId: saveId,
          characters: characters.map((c) => ({
            characterId: c.characterId,
            name: c.name,
            availableForAudience: c.availableForAudience,
          })),
          meetings,
          policyTemplates,
          selectedParticipants: characters
            .filter((c) => c.availableForAudience)
            .map((c) => c.characterId),
          session: undefined,
          turns: [],
          outcomes: [],
        });
        await refreshHead(saveId);
      });
    },

    async refreshMeeting(meetingId) {
      const saveId = get().selectedSaveId;
      const id = meetingId ?? get().session?.meetingId;
      if (!saveId || !id) return;
      const [detail, turnsResult, outcomes] = await Promise.all([
        getMeeting(saveId, id),
        listTurns(saveId, id),
        listOutcomes(saveId, id),
      ]);
      set({
        session: detail.session,
        agenda: detail.agenda,
        turns: turnsResult.turns,
        outcomes,
        meetings: await listMeetings(saveId),
      });
    },

    setField(field, value) {
      set({ [field]: value } as never);
    },
    toggleParticipant(characterId) {
      const current = get().selectedParticipants;
      set({
        selectedParticipants: current.includes(characterId)
          ? current.filter((id) => id !== characterId)
          : [...current, characterId],
      });
    },
    setTarget(characterId) {
      set({ targetCharacterId: characterId });
    },

    async create() {
      await guarded(async () => {
        const state = get();
        const saveId = state.selectedSaveId!;
        const revision = await refreshHead(saveId);
        const session = await createMeeting(saveId, {
          type: state.newType,
          title: state.newTitle,
          purpose: state.newTitle,
          participantIds: [...state.selectedParticipants],
          expectedRevision: revision,
        });
        await addAgenda(saveId, session.meetingId, {
          title: state.newAgendaTitle,
          description: state.newAgendaTitle,
          ...(state.newAgendaTemplateId ? { relatedEntityIds: [state.newAgendaTemplateId] } : {}),
        });
        await refreshHead(saveId);
        await state.refreshMeeting(session.meetingId);
      });
    },

    async start() {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        const next = await startMeeting(selectedSaveId!, session!.meetingId, {
          expectedRevision: headRevision!,
          expectedMeetingVersion: session!.meetingVersion,
        });
        await refreshHead(selectedSaveId!);
        set({ session: next });
        await get().refreshMeeting(next.meetingId);
      });
    },

    async step() {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        await applyStep(
          await stepMeeting(selectedSaveId!, session!.meetingId, {
            expectedRevision: headRevision!,
            expectedMeetingVersion: session!.meetingVersion,
          }),
        );
      });
    },

    async act(action) {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        await applyStep(
          await submitAction(selectedSaveId!, session!.meetingId, {
            expectedRevision: headRevision!,
            expectedMeetingVersion: session!.meetingVersion,
            action: action as never,
          }),
        );
      });
    },

    async rule(agendaItemId, outcomeIds) {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        await applyStep(
          await issueRuling(selectedSaveId!, session!.meetingId, {
            expectedRevision: headRevision!,
            expectedMeetingVersion: session!.meetingVersion,
            agendaItemId,
            selectedOutcomeCandidateIds: outcomeIds,
          }),
        );
      });
    },

    async conclude() {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        await applyStep(
          await concludeMeeting(selectedSaveId!, session!.meetingId, {
            expectedRevision: headRevision!,
            expectedMeetingVersion: session!.meetingVersion,
          }),
        );
      });
    },

    async pause() {
      await guarded(async () => {
        const { selectedSaveId, session } = get();
        await pauseMeeting(selectedSaveId!, session!.meetingId, "调试暂停");
        await get().refreshMeeting();
      });
    },
    async resume() {
      await guarded(async () => {
        const { selectedSaveId, session } = get();
        await resumeMeeting(selectedSaveId!, session!.meetingId);
        await get().refreshMeeting();
      });
    },
    async cancel() {
      await guarded(async () => {
        const { selectedSaveId, session, headRevision } = get();
        await cancelMeeting(selectedSaveId!, session!.meetingId, {
          expectedRevision: headRevision!,
          reason: "调试取消",
        });
        await refreshHead(selectedSaveId!);
        await get().refreshMeeting();
      });
    },
    async loadLeak() {
      await guarded(async () => {
        const { selectedSaveId, session } = get();
        set({ leak: await getDebugLeak(selectedSaveId!, session!.meetingId) });
      });
    },
  };
});
