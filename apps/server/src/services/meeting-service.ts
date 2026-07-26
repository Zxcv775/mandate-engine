import {
  DEFAULT_MEETING_LIMITS,
  MeetingPlayerActionSchema,
  type CharacterMemoryCandidate,
  type CharacterTemplate,
  type EngineMeetingType,
  type GameState,
  type Institution,
  type MeetingAgendaItem,
  type MeetingCharacterOutput,
  type MeetingOutcomeCandidate,
  type MeetingParticipantState,
  type MeetingPlayerAction,
  type MeetingSessionState,
  type MeetingTurnRecord,
  type MeetingVisibility,
  type Office,
} from "@mandate/domain";
import type { ScenarioLoader } from "@mandate/data-loader";
import {
  CharacterAgent,
  CharacterContextBuilder,
  effectiveAccessLevel,
  evaluateMemoryCandidates,
  resolveAccessContext,
  type CharacterAgentLlm,
} from "@mandate/agent-runtime";
import {
  MeetingEngineError,
  assessMeetingLeak,
  buildMeetingSummaryMemoryCandidate,
  generateMeetingMinutes,
  mapOutcomeToCommand,
  planNextStep,
  transitionMeeting,
  type CharacterResponseMode,
  type MeetingDirectorResult,
  type SpeakerCandidateInput,
} from "@mandate/meeting-engine";
import type {
  CharacterMemoryRepository,
  GameStateService,
  MeetingRepository,
} from "@mandate/save-system";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/index";
import { ApiError } from "../errors/api-error";
import type { LlmServiceLogger } from "./llm-service";

/**
 * Meeting Service（§13/§14/§15/§16）：会议编排的应用服务层。
 * - 状态推进一律经 Meeting State Machine + meetingVersion 乐观锁；
 * - Agent 回合两阶段提交（预留 → Provider 调用在事务外 → 原子落库），
 *   崩溃后凭 pendingAgentAction + actionId 恢复，重试幂等（ADR-020）；
 * - 世界状态只经 meeting.* GameCommand 与玩家裁决映射的白名单命令变更；
 * - 会议发言不是世界事实；候选不会自动执行。
 */

export interface MeetingServiceOptions {
  gameStateService: GameStateService;
  meetings: MeetingRepository;
  memories: CharacterMemoryRepository;
  scenarioLoader: ScenarioLoader;
  llm: CharacterAgentLlm;
  config: RuntimeConfig;
  logger: LlmServiceLogger;
  idFactory?: () => string;
  clock?: { now(): Date };
}

export interface CreateMeetingInput {
  meetingId?: string;
  type: EngineMeetingType;
  title: string;
  purpose: string;
  participantIds: string[];
  chairCharacterId?: string;
  visibility?: MeetingVisibility;
  expectedRevision: number;
}

export interface AddAgendaInput {
  agendaItemId?: string;
  title: string;
  description: string;
  topicIds?: string[];
  relatedEntityIds?: string[];
  requiredOfficeIds?: string[];
  maxTurns?: number;
  visibility?: MeetingVisibility;
}

export interface StepInput {
  expectedRevision: number;
  expectedMeetingVersion: number;
  idempotencyKey?: string;
}

export interface PlayerActionInput extends StepInput {
  action: MeetingPlayerAction;
}

export interface RulingInput extends StepInput {
  agendaItemId: string;
  selectedOutcomeCandidateIds: string[];
  text?: string;
}

export interface MeetingStepResult {
  session: MeetingSessionState;
  decisionType: string;
  reason: string;
  newTurn?: MeetingTurnRecord;
  scheduling?: MeetingDirectorResult["scheduling"];
  acceptedCommands?: number;
}

interface ScenarioTemplates {
  scenarioName: string;
  characters: CharacterTemplate[];
  offices: Office[];
  institutions: Institution[];
  /** Phase 5：政策模板 ID（recommend-policy 候选映射用） */
  policyTemplateIds: string[];
}

const RESPONSE_MODE_LABELS: Record<CharacterResponseMode, string> = {
  speech: "陈奏",
  answer: "答问",
  rebuttal: "回应他人",
  warning: "警示",
};

const TURN_TYPE_BY_RESPONSE: Record<
  MeetingCharacterOutput["responseType"],
  MeetingTurnRecord["type"]
> = {
  speech: "character-speech",
  answer: "character-answer",
  rebuttal: "character-rebuttal",
  warning: "character-warning",
  decline: "character-answer",
};

const MEETING_TYPE_LABELS: Record<EngineMeetingType, string> = {
  "court-assembly": "大朝会",
  "imperial-council": "御前会议",
  "secret-council": "秘密议事",
};

function defaultTurnVisibility(
  session: MeetingSessionState,
  agendaItem?: MeetingAgendaItem,
): MeetingVisibility {
  if (agendaItem && (agendaItem.visibility === "sealed" || agendaItem.visibility === "private")) {
    return agendaItem.visibility;
  }
  if (session.type === "court-assembly") return "court";
  if (session.type === "secret-council") return "private";
  return "meeting";
}

export class MeetingService {
  private readonly templatesByScenario = new Map<string, Promise<ScenarioTemplates>>();
  private readonly idFactory: () => string;
  private readonly clock: { now(): Date };

  constructor(private readonly options: MeetingServiceOptions) {
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.clock = options.clock ?? { now: () => new Date() };
  }

  private loadTemplates(scenarioId: string): Promise<ScenarioTemplates> {
    let cached = this.templatesByScenario.get(scenarioId);
    if (!cached) {
      cached = this.options.scenarioLoader.loadScenarioBundle(scenarioId).then((bundle) => ({
        scenarioName: bundle.scenario.name,
        characters: structuredClone(bundle.characters) as CharacterTemplate[],
        offices: structuredClone(bundle.offices) as Office[],
        institutions: structuredClone(bundle.institutions) as Institution[],
        policyTemplateIds: bundle.policyTemplates.map((template) => template.id),
      }));
      this.templatesByScenario.set(scenarioId, cached);
    }
    return cached;
  }

  private async loadSaveContext(saveId: string) {
    const metadata = await this.options.gameStateService.getSave(saveId);
    const [state, templates] = await Promise.all([
      this.options.gameStateService.loadState(saveId),
      this.loadTemplates(metadata.scenarioId),
    ]);
    return { state, templates };
  }

  private speakerLabels(templates: ScenarioTemplates): Record<string, string> {
    return {
      emperor: "皇帝",
      ...Object.fromEntries(templates.characters.map((c) => [c.id, c.name])),
    };
  }

  private assertRevision(state: GameState, expectedRevision: number): void {
    if (state.revision !== expectedRevision) {
      throw new ApiError(
        409,
        "STATE_REVISION_CONFLICT",
        `revision 过期：期望 ${expectedRevision}，当前 ${state.revision}`,
      );
    }
  }

  // ---- 生命周期 ----------------------------------------------------------

  async createMeeting(saveId: string, input: CreateMeetingInput): Promise<MeetingSessionState> {
    const { state } = await this.loadSaveContext(saveId);
    this.assertRevision(state, input.expectedRevision);
    const meetingId = input.meetingId ?? `meeting_${this.idFactory()}`;
    const chair = input.chairCharacterId ?? "emperor";
    const visibility =
      input.visibility ?? (input.type === "secret-council" ? "private" : "meeting");

    // GameState 最小投影（经 StateEngine，revision+1）
    await this.options.gameStateService.commitCommand({
      commandId: `cmd_meeting_create_${this.idFactory()}`,
      commandType: "meeting.create",
      saveId,
      baseRevision: input.expectedRevision,
      actor: { type: "system", id: "meeting-director" },
      payload: {
        meetingId,
        meetingType: input.type,
        participantIds: input.participantIds,
        chairCharacterId: chair,
        visibility,
      },
      createdAt: this.clock.now().toISOString(),
    });

    const now = this.clock.now().toISOString();
    let session: MeetingSessionState = {
      meetingId,
      saveId,
      type: input.type,
      status: "draft",
      title: input.title,
      purpose: input.purpose,
      createdAtRevision: input.expectedRevision + 1,
      meetingVersion: 0,
      turnNumber: 0,
      participantIds: [...input.participantIds],
      chairCharacterId: chair,
      agendaItemIds: [],
      limits: DEFAULT_MEETING_LIMITS,
      usedTurns: 0,
      visibility,
      outcomeCandidateIds: [],
      createdAt: now,
      updatedAt: now,
    };
    session = transitionMeeting(session, { type: "meeting.schedule" }).next;
    const participants: MeetingParticipantState[] = input.participantIds.map((characterId) => ({
      meetingId,
      characterId,
      role: characterId === chair ? "chair" : "minister",
      attendance: "present",
      speakingRights:
        input.type === "court-assembly" && characterId !== chair ? "by-permission" : "normal",
      turnsSpoken: 0,
      requestedToSpeak: false,
      challengedCharacterIds: [],
      runtimeFlags: [],
    }));
    this.options.meetings.createSession(session, participants, []);
    return session;
  }

  async addAgendaItem(
    saveId: string,
    meetingId: string,
    input: AddAgendaInput,
  ): Promise<MeetingAgendaItem> {
    const session = this.requireSession(saveId, meetingId);
    if (session.status !== "draft" && session.status !== "scheduled") {
      throw new ApiError(409, "MEETING_INVALID_STATE", `当前状态不允许调整议程：${session.status}`);
    }
    const item: MeetingAgendaItem = {
      agendaItemId: input.agendaItemId ?? `agenda_${this.idFactory()}`,
      meetingId,
      title: input.title,
      description: input.description,
      topicIds: input.topicIds ?? [],
      proposerId: "emperor",
      status: "queued",
      priority: 50,
      sequence: session.agendaItemIds.length,
      maxTurns: input.maxTurns ?? session.limits.maxTurnsPerAgenda,
      usedTurns: 0,
      relatedEntityIds: input.relatedEntityIds ?? [],
      requiredOfficeIds: input.requiredOfficeIds ?? [],
      visibility: input.visibility ?? session.visibility,
    };
    this.options.meetings.upsertAgendaItem(item);
    this.options.meetings.updateSession(
      {
        ...session,
        agendaItemIds: [...session.agendaItemIds, item.agendaItemId],
        meetingVersion: session.meetingVersion + 1,
      },
      session.meetingVersion,
    );
    return item;
  }

  async startMeeting(
    saveId: string,
    meetingId: string,
    input: StepInput,
  ): Promise<MeetingSessionState> {
    let session = this.requireSession(saveId, meetingId);
    if (session.meetingVersion !== input.expectedMeetingVersion) {
      throw new ApiError(409, "MEETING_VERSION_STALE", "meetingVersion 过期");
    }
    const { state } = await this.loadSaveContext(saveId);
    this.assertRevision(state, input.expectedRevision);

    const result = await this.options.gameStateService.commitCommand({
      commandId: `cmd_meeting_start_${this.idFactory()}`,
      commandType: "meeting.start",
      saveId,
      baseRevision: input.expectedRevision,
      actor: { type: "system", id: "meeting-director" },
      payload: { meetingId },
      createdAt: this.clock.now().toISOString(),
    });

    const expected = session.meetingVersion;
    session = transitionMeeting(session, { type: "meeting.start-preparation" }).next;
    session = transitionMeeting(session, { type: "meeting.start" }).next;
    session = { ...session, startedAtRevision: result.revision };
    this.options.meetings.updateSession(session, expected);
    this.appendSystemTurn(session, "opening", "皇帝驾临，会议开始。", result.revision);
    return this.requireSession(saveId, meetingId);
  }

  // ---- 玩家动作 ----------------------------------------------------------

  async submitPlayerAction(
    saveId: string,
    meetingId: string,
    input: PlayerActionInput,
  ): Promise<MeetingStepResult> {
    const action = MeetingPlayerActionSchema.parse(input.action);
    let session = this.requireSession(saveId, meetingId);
    if (session.meetingVersion !== input.expectedMeetingVersion) {
      throw new ApiError(409, "MEETING_VERSION_STALE", "meetingVersion 过期");
    }
    const { state, templates } = await this.loadSaveContext(saveId);
    this.assertRevision(state, input.expectedRevision);

    // 管理类动作直接执行
    switch (action.type) {
      case "grant-speaking-right": {
        const participant = this.requireParticipant(meetingId, action.characterId);
        this.options.meetings.upsertParticipant({
          ...participant,
          grantedByEmperorAtTurn: session.turnNumber,
          requestedToSpeak: false,
        });
        return this.stepResult(session, "player-action", "已授予发言权");
      }
      case "deny-speaking-right": {
        const participant = this.requireParticipant(meetingId, action.characterId);
        this.options.meetings.upsertParticipant({
          ...participant,
          speakingRights: "silenced",
          requestedToSpeak: false,
        });
        return this.stepResult(session, "player-action", "已禁止发言");
      }
      case "pause-meeting": {
        const expected = session.meetingVersion;
        session = transitionMeeting(session, {
          type: "meeting.pause",
          reason: action.reason ?? "圣裁暂停",
        }).next;
        this.options.meetings.updateSession(session, expected);
        return this.stepResult(session, "player-action", "会议已暂停");
      }
      case "defer-agenda": {
        const agenda = this.requireAgenda(meetingId, action.agendaItemId);
        this.options.meetings.upsertAgendaItem({ ...agenda, status: "deferred" });
        const expected = session.meetingVersion;
        let next = { ...session, meetingVersion: session.meetingVersion };
        if (session.currentAgendaItemId === action.agendaItemId) {
          if (session.status === "resolving") {
            next = transitionMeeting(session, {
              type: "meeting.resolve-agenda",
              agendaItemId: action.agendaItemId,
            }).next;
          } else {
            next = { ...session, meetingVersion: session.meetingVersion + 1 };
            delete (next as { currentAgendaItemId?: string }).currentAgendaItemId;
          }
        } else {
          next = { ...session, meetingVersion: session.meetingVersion + 1 };
        }
        this.options.meetings.updateSession(next, expected);
        return this.stepResult(next, "player-action", "议程已延后");
      }
      case "conclude-meeting":
        return this.concludeMeeting(saveId, meetingId, input);
      case "issue-ruling":
        return this.issueRuling(saveId, meetingId, {
          ...input,
          agendaItemId: action.agendaItemId,
          selectedOutcomeCandidateIds: action.selectedOutcomeCandidateIds,
          ...(action.text === undefined ? {} : { text: action.text }),
        });
      default:
        break;
    }

    // 对话类动作：写入玩家回合，等待 step 推进
    if (session.status !== "in-progress" && session.status !== "waiting-for-player") {
      throw new ApiError(
        409,
        "MEETING_ACTION_NOT_ALLOWED",
        `当前状态不接受该动作：${session.status}`,
      );
    }
    const turnType =
      action.type === "interrupt-character"
        ? "player-interruption"
        : action.type === "address-meeting"
          ? "player-statement"
          : action.type === "request-rebuttal"
            ? "chair-intervention"
            : action.type === "open-next-agenda"
              ? "agenda-transition"
              : "player-question";
    const text =
      "text" in action && action.text
        ? action.text
        : action.type === "request-rebuttal"
          ? `命${this.speakerLabels(templates)[action.characterId] ?? action.characterId}回应`
          : action.type === "open-next-agenda"
            ? "进入下一议程"
            : "（无言语）";

    const expected = session.meetingVersion;
    let next = session;
    if (session.status === "waiting-for-player") {
      next = transitionMeeting(session, { type: "meeting.step-completed" }).next;
    } else {
      next = { ...session, meetingVersion: session.meetingVersion + 1 };
    }
    const agendaItem = session.currentAgendaItemId
      ? this.requireAgenda(meetingId, session.currentAgendaItemId)
      : undefined;
    const turn: MeetingTurnRecord = {
      turnId: `turn_${this.idFactory()}`,
      meetingId,
      saveId,
      ...(session.currentAgendaItemId === undefined
        ? {}
        : { agendaItemId: session.currentAgendaItemId }),
      turnNumber: session.turnNumber,
      type: turnType,
      speakerId: "emperor",
      addressedCharacterIds:
        "characterId" in action && typeof action.characterId === "string"
          ? [action.characterId]
          : [],
      publicText: text,
      privateMetadata: { playerAction: structuredClone(action) as never },
      visibility: defaultTurnVisibility(session, agendaItem),
      stateRevision: state.revision,
      meetingVersion: next.meetingVersion,
      sourceTurnIds: [],
      createdAt: this.clock.now().toISOString(),
    };
    next = { ...next, turnNumber: next.turnNumber + 1, usedTurns: next.usedTurns + 1 };
    try {
      this.options.meetings.appendTurn(turn);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
    this.options.meetings.updateSession(next, expected);
    if (agendaItem) {
      this.options.meetings.upsertAgendaItem({
        ...agendaItem,
        usedTurns: agendaItem.usedTurns + 1,
      });
    }
    return { ...this.stepResult(next, "player-action", "玩家发言已记录"), newTurn: turn };
  }

  // ---- 会议推进（含两阶段 Agent 回合） ------------------------------------

  async step(saveId: string, meetingId: string, input: StepInput): Promise<MeetingStepResult> {
    let session = this.requireSession(saveId, meetingId);
    if (session.meetingVersion !== input.expectedMeetingVersion) {
      throw new ApiError(409, "MEETING_VERSION_STALE", "meetingVersion 过期");
    }
    const { state, templates } = await this.loadSaveContext(saveId);
    this.assertRevision(state, input.expectedRevision);

    // 恢复路径：存在 pending Agent 回合 → 以同一 actionId 重试阶段 B
    if (session.pendingAgentAction) {
      return this.executeAgentTurn(saveId, session, state, templates, {
        characterId: session.pendingAgentAction.characterId,
        responseMode: session.pendingAgentAction.responseMode,
        addressedCharacterIds: session.pendingAgentAction.addressedCharacterIds,
        actionId: session.pendingAgentAction.actionId,
        alreadyReserved: true,
      });
    }

    if (session.status === "waiting-for-player") {
      return this.stepResult(
        session,
        "request-player-action",
        session.pendingPlayerAction?.reason ?? "等待圣裁",
      );
    }
    if (session.status !== "in-progress") {
      throw new ApiError(409, "MEETING_INVALID_STATE", `当前状态不可推进：${session.status}`);
    }

    const agenda = this.options.meetings.listAgendaItems(meetingId);
    const participants = this.options.meetings.listParticipants(meetingId);
    const recentTurns = this.recentTurns(meetingId);
    const lastPlayerAction = this.reconstructLastPlayerAction(recentTurns);
    const candidates = this.buildCandidates(session, state, templates, participants, agenda);

    let director: MeetingDirectorResult;
    try {
      director = planNextStep({
        session,
        agenda,
        recentTurns,
        candidates,
        ...(lastPlayerAction === undefined ? {} : { lastPlayerAction }),
      });
    } catch (error) {
      throw this.mapEngineError(error);
    }
    const decision = director.decision;

    switch (decision.type) {
      case "request-player-action": {
        const expected = session.meetingVersion;
        session = transitionMeeting(session, {
          type: "meeting.await-player",
          action: {
            allowedActions: [...decision.allowedActions],
            reason: decision.reason,
            requestedAtTurn: session.turnNumber,
          },
        }).next;
        this.options.meetings.updateSession(session, expected);
        return {
          ...this.stepResult(session, decision.type, decision.reason),
          ...(director.scheduling === undefined ? {} : { scheduling: director.scheduling }),
        };
      }
      case "advance-agenda": {
        const next = this.requireAgenda(meetingId, decision.nextAgendaItemId);
        this.options.meetings.upsertAgendaItem({ ...next, status: "discussing" });
        const expected = session.meetingVersion;
        session = transitionMeeting(session, {
          type: "meeting.open-agenda",
          agendaItemId: decision.nextAgendaItemId,
        }).next;
        session = { ...session, turnNumber: session.turnNumber + 1 };
        const turn = this.systemTurnRecord(
          session,
          "agenda-transition",
          `进入议程：${next.title}`,
          state.revision,
          decision.nextAgendaItemId,
        );
        try {
          this.options.meetings.appendTurn(turn);
        } catch (error) {
          throw this.mapRepositoryError(error);
        }
        this.options.meetings.updateSession(session, expected);
        return { ...this.stepResult(session, decision.type, decision.reason), newTurn: turn };
      }
      case "prepare-decision": {
        const agendaItem = this.requireAgenda(meetingId, decision.agendaItemId);
        this.options.meetings.upsertAgendaItem({ ...agendaItem, status: "decision-pending" });
        const expected = session.meetingVersion;
        session = transitionMeeting(session, {
          type: "meeting.begin-resolution",
          agendaItemId: decision.agendaItemId,
        }).next;
        this.options.meetings.updateSession(session, expected);
        return this.stepResult(session, decision.type, decision.reason);
      }
      case "conclude-meeting":
        return this.concludeMeeting(saveId, meetingId, input);
      case "request-character-response":
        return this.executeAgentTurn(saveId, session, state, templates, {
          characterId: decision.characterId,
          responseMode: decision.responseMode,
          addressedCharacterIds: [...decision.addressedCharacterIds],
          actionId: input.idempotencyKey ?? `act_${this.idFactory()}`,
          alreadyReserved: false,
          scheduling: director.scheduling,
        });
    }
  }

  /** 两阶段 Agent 回合（ADR-020）：阶段 A 预留 → Provider 调用（事务外）→ 阶段 B 原子提交 */
  private async executeAgentTurn(
    saveId: string,
    inputSession: MeetingSessionState,
    state: GameState,
    templates: ScenarioTemplates,
    request: {
      characterId: string;
      responseMode: CharacterResponseMode;
      addressedCharacterIds: string[];
      actionId: string;
      alreadyReserved: boolean;
      scheduling?: MeetingDirectorResult["scheduling"];
    },
  ): Promise<MeetingStepResult> {
    let session = inputSession;
    // 幂等：该 actionId 已有回合 → 清 pending 收尾即可
    if (this.options.meetings.hasTurnForAction(request.actionId)) {
      if (session.pendingAgentAction?.actionId === request.actionId) {
        const expected = session.meetingVersion;
        session = transitionMeeting(session, {
          type: "meeting.agent-completed",
          characterId: request.characterId,
        }).next;
        this.options.meetings.updateSession(session, expected);
      }
      return this.stepResult(session, "agent-turn", "该回合已提交（幂等恢复）");
    }

    // 阶段 A：原子预留
    if (!request.alreadyReserved) {
      const expected = session.meetingVersion;
      session = transitionMeeting(session, {
        type: "meeting.await-agent",
        characterId: request.characterId,
      }).next;
      session = {
        ...session,
        pendingAgentAction: {
          actionId: request.actionId,
          characterId: request.characterId,
          responseMode: request.responseMode,
          addressedCharacterIds: request.addressedCharacterIds,
          reservedAtTurn: session.turnNumber,
          reservedAt: this.clock.now().toISOString(),
        },
      };
      this.options.meetings.updateSession(session, expected);
    } else if (session.status !== "waiting-for-agent") {
      // 恢复路径（如 failed→paused→resume 后）：重新宣告等待该角色，保持同一 actionId
      const expected = session.meetingVersion;
      session = transitionMeeting(session, {
        type: "meeting.await-agent",
        characterId: request.characterId,
      }).next;
      this.options.meetings.updateSession(session, expected);
    }

    // Provider 调用（不持有任何数据库事务）
    const agendaItem = session.currentAgendaItemId
      ? this.requireAgenda(session.meetingId, session.currentAgendaItemId)
      : undefined;
    const labels = this.speakerLabels(templates);
    const visibleTurns = this.visibleTurnsFor(session, request.characterId);
    const lastPlayerTurn = [...visibleTurns].reverse().find((turn) => turn.speakerId === "emperor");
    const agent = this.buildAgent(saveId, templates);
    let agentResult;
    try {
      agentResult = await agent.respondInMeeting({
        saveId,
        characterId: request.characterId,
        meetingType: session.type,
        meetingPrompt: {
          meetingTitle: session.title,
          meetingTypeLabel: MEETING_TYPE_LABELS[session.type],
          agendaTitle: agendaItem?.title ?? session.purpose,
          agendaDescription: agendaItem?.description ?? session.purpose,
          currentTurnNumber: session.turnNumber,
          responseModeLabel: RESPONSE_MODE_LABELS[request.responseMode],
          ...(request.responseMode === "answer" ? { addressedByLabel: "皇帝" } : {}),
          relatedPolicyTemplateIds: (agendaItem?.relatedEntityIds ?? []).filter((id) =>
            templates.policyTemplateIds.includes(id),
          ),
          transcript: visibleTurns.map((turn) => ({
            turnId: turn.turnId,
            speakerLabel: labels[turn.speakerId] ?? turn.speakerId,
            text: turn.publicText,
          })),
        },
        participantIds: session.participantIds,
        input: {
          speakerId: "emperor",
          text: lastPlayerTurn?.publicText ?? `议题：${agendaItem?.title ?? session.purpose}`,
        },
        ...(agendaItem === undefined ? {} : { topic: agendaItem.agendaItemId }),
        expectedRevision: state.revision,
        visibleTurnIds: visibleTurns.map((turn) => turn.turnId),
      });
    } catch (error) {
      // Provider/一致性失败：标记 failed，pending 保留以便恢复或取消
      const expected = session.meetingVersion;
      session = transitionMeeting(session, {
        type: "meeting.fail",
        errorCode:
          error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "PROVIDER_REQUEST_FAILED",
      }).next;
      this.options.meetings.updateSession(session, expected);
      throw error;
    }

    // 阶段 B：原子提交（回合 + 会议 head）
    const output = agentResult.output;
    const turn: MeetingTurnRecord = {
      turnId: `turn_${this.idFactory()}`,
      meetingId: session.meetingId,
      saveId,
      ...(session.currentAgendaItemId === undefined
        ? {}
        : { agendaItemId: session.currentAgendaItemId }),
      turnNumber: session.turnNumber,
      type: TURN_TYPE_BY_RESPONSE[output.responseType],
      speakerId: request.characterId,
      addressedCharacterIds: [...output.addressedCharacterIds],
      publicText: output.speech,
      privateMetadata: {
        stance: output.stance.position,
        responseType: output.responseType,
        suggestsAgendaResolution: output.suggestsAgendaResolution,
      },
      visibility: defaultTurnVisibility(session, agendaItem),
      stateRevision: state.revision,
      meetingVersion: session.meetingVersion + 1,
      actionId: request.actionId,
      sourceTurnIds: [...output.referencedTurnIds],
      promptVersions: { ...agentResult.prompt.manifest.promptVersions },
      providerTrace: {
        provider: agentResult.provider,
        model: agentResult.model,
        durationMs: agentResult.durationMs,
        repaired: agentResult.repaired,
      },
      createdAt: this.clock.now().toISOString(),
    };
    const expected = session.meetingVersion;
    let next = transitionMeeting(session, {
      type: "meeting.agent-completed",
      characterId: request.characterId,
    }).next;
    next = { ...next, turnNumber: next.turnNumber + 1, usedTurns: next.usedTurns + 1 };
    try {
      this.options.meetings.commitAgentTurn(turn, next, expected);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }

    // 附属写入（非会议 head 一致性关键路径）：参与者统计、议程回合数、候选与记忆
    const participant = this.requireParticipant(session.meetingId, request.characterId);
    this.options.meetings.upsertParticipant({
      ...participant,
      turnsSpoken: participant.turnsSpoken + 1,
      lastSpokeAtTurn: turn.turnNumber,
      requestedToSpeak: output.requestsToSpeakAgain,
    });
    if (agendaItem) {
      this.options.meetings.upsertAgendaItem({
        ...agendaItem,
        usedTurns: agendaItem.usedTurns + 1,
        status: agendaItem.status === "open" ? "discussing" : agendaItem.status,
      });
    }
    this.recordOutcomeCandidates(
      next,
      state,
      turn,
      output,
      templates.policyTemplateIds,
      agendaItem,
    );
    this.persistAgentMemories(saveId, request.characterId, state.revision, output);
    this.options.logger.info({
      event: "meeting_agent_turn",
      saveId,
      meetingId: session.meetingId,
      characterId: request.characterId,
      actionId: request.actionId,
      turnNumber: turn.turnNumber,
      provider: agentResult.provider,
      repaired: agentResult.repaired,
      durationMs: agentResult.durationMs,
    });
    return {
      ...this.stepResult(
        next,
        "agent-turn",
        `${labels[request.characterId] ?? request.characterId}已奏对`,
      ),
      newTurn: turn,
      ...(request.scheduling === undefined ? {} : { scheduling: request.scheduling }),
    };
  }

  // ---- 裁决与收尾 --------------------------------------------------------

  async issueRuling(
    saveId: string,
    meetingId: string,
    input: RulingInput,
  ): Promise<MeetingStepResult> {
    let session = this.requireSession(saveId, meetingId);
    if (session.meetingVersion !== input.expectedMeetingVersion) {
      throw new ApiError(409, "MEETING_VERSION_STALE", "meetingVersion 过期");
    }
    const context = await this.loadSaveContext(saveId);
    let state = context.state;
    const policyTemplateIds = context.templates.policyTemplateIds;
    this.assertRevision(state, input.expectedRevision);

    const agendaItem = this.requireAgenda(meetingId, input.agendaItemId);
    if (agendaItem.status === "resolved" || agendaItem.status === "rejected") {
      throw new ApiError(409, "MEETING_RULING_INVALID", "该议程已经裁决，不得重复");
    }
    const outcomes = this.options.meetings.listOutcomeCandidates(meetingId);
    const selected = input.selectedOutcomeCandidateIds.map((id) => {
      const candidate = outcomes.find((o) => o.outcomeCandidateId === id);
      if (!candidate || candidate.agendaItemId !== input.agendaItemId) {
        throw new ApiError(422, "MEETING_RULING_INVALID", `候选不存在或不属于该议程：${id}`);
      }
      if (candidate.status === "accepted") {
        throw new ApiError(409, "MEETING_RULING_INVALID", `候选已被接受，不得重复裁决：${id}`);
      }
      return candidate;
    });

    // 白名单映射 → StateEngine 提交（唯一世界写路径）
    let baseRevision = state.revision;
    let acceptedCommands = 0;
    for (const candidate of selected) {
      const mapping = mapOutcomeToCommand(candidate, state, { policyTemplateIds });
      if (!mapping.ok) {
        if (candidate.type === "no-action" || candidate.type === "agenda-deferral") {
          continue; // 无命令语义的候选：接受即记录
        }
        throw new ApiError(
          mapping.code === "MEETING_OUTCOME_UNSUPPORTED" ? 422 : 422,
          mapping.code,
          mapping.reason,
        );
      }
      await this.options.gameStateService.commitCommand({
        ...mapping.command,
        commandId: `cmd_ruling_${this.idFactory()}`,
        baseRevision,
        actor: { type: "system", id: "meeting-director" },
        createdAt: this.clock.now().toISOString(),
      } as never);
      baseRevision += 1;
      acceptedCommands += 1;
      state = await this.options.gameStateService.loadState(saveId);
    }

    for (const candidate of selected) {
      this.options.meetings.updateOutcomeStatus(candidate.outcomeCandidateId, "accepted");
    }
    for (const candidate of outcomes.filter(
      (o) =>
        o.agendaItemId === input.agendaItemId &&
        !input.selectedOutcomeCandidateIds.includes(o.outcomeCandidateId) &&
        (o.status === "draft" || o.status === "presented"),
    )) {
      this.options.meetings.updateOutcomeStatus(candidate.outcomeCandidateId, "rejected");
    }
    this.options.meetings.upsertAgendaItem({ ...agendaItem, status: "resolved" });

    const expected = session.meetingVersion;
    if (session.status === "resolving") {
      session = transitionMeeting(session, {
        type: "meeting.resolve-agenda",
        agendaItemId: input.agendaItemId,
      }).next;
    } else if (session.status === "waiting-for-player") {
      session = transitionMeeting(session, { type: "meeting.step-completed" }).next;
      if (session.currentAgendaItemId === input.agendaItemId) {
        delete (session as { currentAgendaItemId?: string }).currentAgendaItemId;
      }
    } else {
      session = { ...session, meetingVersion: session.meetingVersion + 1 };
      if (session.currentAgendaItemId === input.agendaItemId) {
        delete (session as { currentAgendaItemId?: string }).currentAgendaItemId;
      }
    }
    session = { ...session, turnNumber: session.turnNumber + 1, usedTurns: session.usedTurns + 1 };
    const turn = this.systemTurnRecord(
      session,
      "player-ruling",
      input.text ?? `圣裁：准${selected.map((c) => c.title).join("、") || "如议"}`,
      baseRevision,
      input.agendaItemId,
    );
    try {
      this.options.meetings.appendTurn(turn);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
    this.options.meetings.updateSession(session, expected);
    return {
      ...this.stepResult(session, "player-ruling", "裁决已生效"),
      newTurn: turn,
      acceptedCommands,
    };
  }

  async pauseMeeting(
    saveId: string,
    meetingId: string,
    reason: string,
  ): Promise<MeetingSessionState> {
    let session = this.requireSession(saveId, meetingId);
    const expected = session.meetingVersion;
    session = transitionMeeting(session, { type: "meeting.pause", reason }).next;
    this.options.meetings.updateSession(session, expected);
    return session;
  }

  async resumeMeeting(saveId: string, meetingId: string): Promise<MeetingSessionState> {
    let session = this.requireSession(saveId, meetingId);
    const expected = session.meetingVersion;
    session = transitionMeeting(session, { type: "meeting.resume" }).next;
    this.options.meetings.updateSession(session, expected);
    return session;
  }

  async cancelMeeting(
    saveId: string,
    meetingId: string,
    input: { expectedRevision: number; reason?: string },
  ): Promise<MeetingSessionState> {
    const session = this.requireSession(saveId, meetingId);
    const reason = input.reason ?? "圣意取消";
    const expected = session.meetingVersion;
    // 先在会话侧验证转换合法（draft/scheduled/preparing/paused/failed → cancelled），
    // 再提交世界投影命令，最后落会话，避免命令成功而会话转换非法的不一致。
    const next = transitionMeeting(session, { type: "meeting.cancel", reason }).next;
    await this.options.gameStateService.commitCommand({
      commandId: `cmd_meeting_cancel_${this.idFactory()}`,
      commandType: "meeting.cancel",
      saveId,
      baseRevision: input.expectedRevision,
      actor: { type: "system", id: "meeting-director" },
      payload: { meetingId, reason },
      createdAt: this.clock.now().toISOString(),
    });
    this.options.meetings.updateSession(next, expected);
    return next;
  }

  async concludeMeeting(
    saveId: string,
    meetingId: string,
    input: StepInput,
  ): Promise<MeetingStepResult> {
    let session = this.requireSession(saveId, meetingId);
    const { state, templates } = await this.loadSaveContext(saveId);
    const agenda = this.options.meetings.listAgendaItems(meetingId);
    const now = this.clock.now().toISOString();

    // 泄密评估（确定性）；触发则由 conclude 命令写入 hidden 队列
    const leak = assessMeetingLeak({
      session,
      agenda,
      state,
      templates: templates.characters,
      createdAt: now,
    });
    this.options.meetings.insertLeakAssessment(leak);
    const leakEventCandidateIds =
      leak.deterministicRoll?.triggered === true ? [`event_leak_${meetingId}`] : [];

    const commandResult = await this.options.gameStateService.commitCommand({
      commandId: `cmd_meeting_conclude_${this.idFactory()}`,
      commandType: "meeting.conclude",
      saveId,
      baseRevision: input.expectedRevision,
      actor: { type: "system", id: "meeting-director" },
      payload: {
        meetingId,
        ...(leakEventCandidateIds.length > 0 ? { leakEventCandidateIds } : {}),
      },
      createdAt: now,
    });

    const expected = session.meetingVersion;
    session = transitionMeeting(session, { type: "meeting.conclude" }).next;
    session = {
      ...session,
      concludedAtRevision: commandResult.revision,
      turnNumber: session.turnNumber + 1,
    };
    const turn = this.systemTurnRecord(
      session,
      "adjournment",
      "会议礼成，散。",
      commandResult.revision,
    );
    try {
      this.options.meetings.appendTurn(turn);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
    this.options.meetings.updateSession(session, expected);

    // 纪要（规则生成，两层）
    const { turns } = this.options.meetings.listTurns(meetingId, { limit: 200 });
    const outcomes = this.options.meetings.listOutcomeCandidates(meetingId);
    const minutes = generateMeetingMinutes({
      session,
      turns,
      outcomes,
      deferredAgendaItemIds: agenda
        .filter((item) => item.status === "deferred")
        .map((item) => item.agendaItemId),
      speakerLabels: this.speakerLabels(templates),
      stateRevision: commandResult.revision,
      createdAt: now,
      idFactory: this.idFactory,
    });
    this.options.meetings.insertMinutes(minutes.official);
    if (minutes.privateMinutes) this.options.meetings.insertMinutes(minutes.privateMinutes);

    // 会议记忆：按各参与者实际可见回合分化生成
    const acceptedOutcomes = outcomes.filter((o) => o.status === "accepted");
    for (const characterId of session.participantIds) {
      if (characterId === "emperor") continue;
      const visible = this.visibleTurnsFor(session, characterId);
      const candidate = buildMeetingSummaryMemoryCandidate(
        session,
        visible,
        acceptedOutcomes,
        this.speakerLabels(templates),
      );
      if (candidate) {
        this.persistApprovedCandidates(saveId, characterId, commandResult.revision, [candidate], {
          sourceMeetingId: meetingId,
        });
      }
    }

    return this.stepResult(session, "conclude-meeting", "会议已结束并生成纪要");
  }

  // ---- 查询 --------------------------------------------------------------

  listMeetings(saveId: string): MeetingSessionState[] {
    return this.options.meetings.listSessions(saveId);
  }

  getMeeting(
    saveId: string,
    meetingId: string,
  ): {
    session: MeetingSessionState;
    participants: MeetingParticipantState[];
    agenda: MeetingAgendaItem[];
  } {
    const session = this.requireSession(saveId, meetingId);
    return {
      session,
      participants: this.options.meetings.listParticipants(meetingId),
      agenda: this.options.meetings.listAgendaItems(meetingId),
    };
  }

  listTurns(
    saveId: string,
    meetingId: string,
    filter: {
      agendaItemId?: string;
      speakerId?: string;
      limit?: number;
      cursor?: number;
      includeConfidential?: boolean;
    },
  ) {
    this.requireSession(saveId, meetingId);
    return this.options.meetings.listTurns(meetingId, {
      ...(filter.agendaItemId === undefined ? {} : { agendaItemId: filter.agendaItemId }),
      ...(filter.speakerId === undefined ? {} : { speakerId: filter.speakerId }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      // 普通 API 只投影到 meeting 级；sealed/private 仅 Debug
      ...(filter.includeConfidential ? {} : { maxVisibility: "meeting" as const }),
    });
  }

  listOutcomes(saveId: string, meetingId: string): MeetingOutcomeCandidate[] {
    this.requireSession(saveId, meetingId);
    return this.options.meetings.listOutcomeCandidates(meetingId);
  }

  getLeakAssessment(saveId: string, meetingId: string) {
    this.requireSession(saveId, meetingId);
    return this.options.meetings.getLeakAssessment(meetingId);
  }

  listMinutes(saveId: string, meetingId: string, characterId?: string) {
    this.requireSession(saveId, meetingId);
    return this.options.meetings.listMinutes(meetingId, characterId);
  }

  // ---- 内部工具 ----------------------------------------------------------

  private requireSession(saveId: string, meetingId: string): MeetingSessionState {
    const session = this.options.meetings.getSession(meetingId);
    if (!session || session.saveId !== saveId) {
      throw new ApiError(404, "MEETING_NOT_FOUND", `会议不存在：${meetingId}`);
    }
    return session;
  }

  private requireParticipant(meetingId: string, characterId: string): MeetingParticipantState {
    const participant = this.options.meetings
      .listParticipants(meetingId)
      .find((p) => p.characterId === characterId);
    if (!participant) {
      throw new ApiError(422, "MEETING_PARTICIPANT_INVALID", `非参会人物：${characterId}`);
    }
    return participant;
  }

  private requireAgenda(meetingId: string, agendaItemId: string): MeetingAgendaItem {
    const item = this.options.meetings
      .listAgendaItems(meetingId)
      .find((a) => a.agendaItemId === agendaItemId);
    if (!item) {
      throw new ApiError(404, "MEETING_AGENDA_NOT_FOUND", `议程不存在：${agendaItemId}`);
    }
    return item;
  }

  private recentTurns(meetingId: string): MeetingTurnRecord[] {
    const { turns } = this.options.meetings.listTurns(meetingId, { limit: 200 });
    return turns.slice(-12);
  }

  /** 该角色可见的回合：按可见性级别 + 在场时段（visibleUntilTurn）过滤 */
  private visibleTurnsFor(session: MeetingSessionState, characterId: string): MeetingTurnRecord[] {
    const participant = this.options.meetings
      .listParticipants(session.meetingId)
      .find((p) => p.characterId === characterId);
    if (!participant) return [];
    const { turns } = this.options.meetings.listTurns(session.meetingId, { limit: 200 });
    return turns.filter((turn) => {
      if (
        participant.visibleUntilTurn !== undefined &&
        turn.turnNumber > participant.visibleUntilTurn
      ) {
        return false;
      }
      return true; // 参与者可见本会议全部级别回合（sealed 议题仍在会议之内）
    });
  }

  private reconstructLastPlayerAction(
    recentTurns: readonly MeetingTurnRecord[],
  ): MeetingPlayerAction | undefined {
    const last = recentTurns.at(-1);
    if (!last || last.speakerId !== "emperor") return undefined;
    const raw = last.privateMetadata?.playerAction;
    if (!raw) return undefined;
    const parsed = MeetingPlayerActionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private buildCandidates(
    session: MeetingSessionState,
    state: GameState,
    templates: ScenarioTemplates,
    participants: readonly MeetingParticipantState[],
    agenda: readonly MeetingAgendaItem[],
  ): SpeakerCandidateInput[] {
    const agendaItem = agenda.find((a) => a.agendaItemId === session.currentAgendaItemId);
    const lastPlayerAction = this.reconstructLastPlayerAction(this.recentTurns(session.meetingId));
    const namedCharacterId =
      lastPlayerAction &&
      (lastPlayerAction.type === "ask-character" ||
        lastPlayerAction.type === "grant-speaking-right")
        ? lastPlayerAction.characterId
        : undefined;
    return participants
      .filter((participant) => participant.characterId !== "emperor")
      .map((participant) => {
        const template = templates.characters.find((c) => c.id === participant.characterId);
        const runtime = state.characters[participant.characterId];
        let topicAccess: "none" | "limited" | "normal" | "privileged" = "normal";
        if (template && runtime && agendaItem && agendaItem.topicIds.length > 0) {
          try {
            const access = resolveAccessContext(
              state,
              template,
              templates.offices,
              templates.institutions,
            );
            // 议题主题若命中人物专长域按其访问级别，否则默认 normal（朝务常识）
            const domainTopic = agendaItem.topicIds.find((topic) =>
              template.knowledgeProfile.accessLevels.some((entry) => entry.domain === topic),
            );
            if (domainTopic) {
              topicAccess = effectiveAccessLevel(access, domainTopic as never);
            }
          } catch {
            topicAccess = "limited";
          }
        }
        return {
          eligibility: {
            characterId: participant.characterId,
            ...(runtime === undefined ? {} : { runtime }),
            participant,
            session,
            ...(agendaItem === undefined ? {} : { agendaItem }),
            topicAccess,
            emperorSelected: namedCharacterId === participant.characterId,
          },
          ...(template === undefined ? {} : { template }),
        };
      });
  }

  private recordOutcomeCandidates(
    session: MeetingSessionState,
    state: GameState,
    turn: MeetingTurnRecord,
    output: MeetingCharacterOutput,
    policyTemplateIds: readonly string[] = [],
    agendaItem?: MeetingAgendaItem,
  ): void {
    if (!session.currentAgendaItemId && !turn.agendaItemId) return;
    const agendaItemId = turn.agendaItemId ?? session.currentAgendaItemId!;
    for (const action of output.proposedActions) {
      if (action.type === "none" || action.type === "decline-to-answer") continue;
      const targetCharacter = action.targetEntityIds.find((id) => state.characters[id]);
      const isAppointment = action.type === "recommend-appointment" && targetCharacter;
      const targetOffice = action.targetEntityIds.find((id) => state.offices[id]);
      // Phase 5：荐策命中已装载政策模板（发言引用或议程关联实体）→ 生成 policy.propose 预览
      const policyTemplateId =
        action.type === "recommend-policy"
          ? (action.targetEntityIds.find((id) => policyTemplateIds.includes(id)) ??
            agendaItem?.relatedEntityIds.find((id) => policyTemplateIds.includes(id)))
          : undefined;
      const candidateType =
        action.type === "recommend-appointment"
          ? targetOffice
            ? "appointment-proposal"
            : "dismissal-proposal"
          : action.type === "recommend-policy"
            ? "policy-proposal"
            : action.type === "request-investigation"
              ? "investigation-request"
              : action.type === "warn-risk"
                ? "information-request"
                : "information-request";
      const commandPreview = isAppointment
        ? {
            commandType: "character.assign-office",
            payload: {
              characterId: targetCharacter,
              officeId: targetOffice ?? null,
              reason: action.summary,
            },
          }
        : policyTemplateId
          ? {
              commandType: "policy.propose",
              payload: { templateId: policyTemplateId, reason: action.summary },
            }
          : undefined;
      const candidate: MeetingOutcomeCandidate = {
        outcomeCandidateId: `outcome_${this.idFactory()}`,
        meetingId: session.meetingId,
        saveId: session.saveId,
        agendaItemId,
        type: candidateType,
        title: action.summary.slice(0, 120),
        summary: action.summary,
        proposerIds: [turn.speakerId],
        supporterIds: [],
        opponentIds: [],
        rationale: [...action.rationale],
        risks: [],
        sourceTurnIds: [turn.turnId],
        status: "presented",
        ...(commandPreview === undefined ? {} : { commandPreview: commandPreview as never }),
        unsupportedCommand: commandPreview === undefined,
        createdAtRevision: state.revision,
        createdAt: this.clock.now().toISOString(),
      };
      this.options.meetings.insertOutcomeCandidate(candidate);
    }
  }

  private persistAgentMemories(
    saveId: string,
    characterId: string,
    sourceRevision: number,
    output: MeetingCharacterOutput,
  ): void {
    this.persistApprovedCandidates(
      saveId,
      characterId,
      sourceRevision,
      output.memoryCandidates,
      {},
    );
  }

  private persistApprovedCandidates(
    saveId: string,
    characterId: string,
    sourceRevision: number,
    candidates: readonly CharacterMemoryCandidate[],
    source: { sourceMeetingId?: string },
  ): void {
    if (candidates.length === 0) return;
    const existing = this.options.memories.listMemories(saveId, characterId, {
      limit: 200,
    }).memories;
    const decision = evaluateMemoryCandidates({
      candidates,
      existingMemories: existing,
      limits: { maxPerCharacter: this.options.config.character.memoryMaxPerCharacter },
    });
    for (const accepted of decision.accepted) {
      this.options.memories.insertMemory({
        saveId,
        characterId,
        candidate: accepted.candidate,
        confidence: accepted.adjustedConfidence,
        sourceRevision,
        ...(source.sourceMeetingId === undefined
          ? {}
          : { sourceMeetingId: source.sourceMeetingId }),
      });
    }
  }

  private buildAgent(saveId: string, templates: ScenarioTemplates): CharacterAgent {
    const contextBuilder = new CharacterContextBuilder(
      {
        loadHeadState: (id) => this.options.gameStateService.loadState(id),
        listMemories: (id, characterId) =>
          this.options.memories.listMemories(id, characterId, { limit: 200 }).memories,
        listRecentTurns: (id, characterId, limit) =>
          this.options.memories.listRecentTurns(id, characterId, limit),
      },
      templates,
    );
    return new CharacterAgent(contextBuilder, this.options.llm, {
      maxRepairAttempts: this.options.config.character.maxRepairAttempts,
      clock: this.clock,
    });
  }

  private appendSystemTurn(
    session: MeetingSessionState,
    type: MeetingTurnRecord["type"],
    text: string,
    stateRevision: number,
  ): void {
    const current = this.options.meetings.getSession(session.meetingId);
    if (!current) return;
    const expected = current.meetingVersion;
    const turn = this.systemTurnRecord(
      { ...current, turnNumber: current.turnNumber + 1 },
      type,
      text,
      stateRevision,
    );
    try {
      this.options.meetings.appendTurn(turn);
      this.options.meetings.updateSession(
        {
          ...current,
          turnNumber: current.turnNumber + 1,
          meetingVersion: current.meetingVersion + 1,
        },
        expected,
      );
    } catch {
      // 开场回合失败不阻断主流程
    }
  }

  private systemTurnRecord(
    session: MeetingSessionState,
    type: MeetingTurnRecord["type"],
    text: string,
    stateRevision: number,
    agendaItemId?: string,
  ): MeetingTurnRecord {
    return {
      turnId: `turn_${this.idFactory()}`,
      meetingId: session.meetingId,
      saveId: session.saveId,
      ...(agendaItemId === undefined
        ? session.currentAgendaItemId === undefined
          ? {}
          : { agendaItemId: session.currentAgendaItemId }
        : { agendaItemId }),
      turnNumber: session.turnNumber - 1 >= 0 ? session.turnNumber - 1 : 0,
      type,
      speakerId: "emperor",
      addressedCharacterIds: [],
      publicText: text,
      visibility: defaultTurnVisibility(session),
      stateRevision,
      meetingVersion: session.meetingVersion,
      sourceTurnIds: [],
      createdAt: this.clock.now().toISOString(),
    };
  }

  private stepResult(
    session: MeetingSessionState,
    decisionType: string,
    reason: string,
  ): MeetingStepResult {
    return { session, decisionType, reason };
  }

  private mapRepositoryError(error: unknown): Error {
    if (error instanceof Error && "code" in error) {
      const code = String((error as { code: unknown }).code);
      if (code === "MEETING_AGENT_RESPONSE_DUPLICATE") {
        return new ApiError(409, "MEETING_AGENT_RESPONSE_DUPLICATE", error.message);
      }
      if (code === "MEETING_VERSION_STALE") {
        return new ApiError(409, "MEETING_VERSION_STALE", error.message);
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private mapEngineError(error: unknown): Error {
    if (error instanceof MeetingEngineError) {
      const status =
        error.code === "MEETING_AGENT_REQUEST_PENDING"
          ? 409
          : error.code === "MEETING_NOT_FOUND"
            ? 404
            : 409;
      return new ApiError(status, error.code, error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
