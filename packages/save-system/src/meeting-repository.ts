import {
  MeetingAgendaItemSchema,
  MeetingLeakAssessmentSchema,
  MeetingMinutesSchema,
  MeetingOutcomeCandidateSchema,
  MeetingParticipantStateSchema,
  MeetingSessionStateSchema,
  MeetingTurnRecordSchema,
  type MeetingAgendaItem,
  type MeetingLeakAssessment,
  type MeetingMinutes,
  type MeetingOutcomeCandidate,
  type MeetingParticipantState,
  type MeetingSessionState,
  type MeetingTurnRecord,
  type MeetingVisibility,
} from "@mandate/domain";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Clock } from "@mandate/game-engine";
import { SaveSystemError } from "./errors";

/**
 * 会议持久层（ADR-018/020）。
 * - meeting_sessions 以 meeting_version 乐观锁推进：任何更新都必须携带期望版本，
 *   版本不符抛 MEETING_VERSION_STALE；
 * - meeting_turns 为 append-only：UNIQUE(meeting_id, turn_number) 与唯一 action_id
 *   保证两阶段 Agent 回合的幂等（重试不产生重复发言）；
 * - 会议内部推进不产生 StateChangeLog、不改变世界 revision。
 */

const VISIBILITY_RANK: Record<MeetingVisibility, number> = {
  court: 0,
  meeting: 1,
  private: 2,
  sealed: 3,
};

export interface TurnListFilter {
  readonly agendaItemId?: string;
  readonly speakerId?: string;
  /** 只返回不高于该保密级别的回合（API 投影用；缺省不过滤） */
  readonly maxVisibility?: MeetingVisibility;
  readonly limit?: number;
  readonly cursor?: number;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

interface SessionRow {
  meeting_id: string;
  save_id: string;
  type: MeetingSessionState["type"];
  status: MeetingSessionState["status"];
  title: string;
  purpose: string;
  created_at_revision: number;
  started_at_revision: number | null;
  concluded_at_revision: number | null;
  meeting_version: number;
  turn_number: number;
  participant_ids_json: string;
  chair_character_id: string;
  agenda_item_ids_json: string;
  current_agenda_item_id: string | null;
  current_speaker_id: string | null;
  pending_player_action_json: string | null;
  pending_agent_action_json: string | null;
  limits_json: string;
  used_turns: number;
  visibility: MeetingVisibility;
  outcome_candidate_ids_json: string;
  pause_reason: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SessionRow): MeetingSessionState {
  return MeetingSessionStateSchema.parse({
    meetingId: row.meeting_id,
    saveId: row.save_id,
    type: row.type,
    status: row.status,
    title: row.title,
    purpose: row.purpose,
    createdAtRevision: row.created_at_revision,
    ...(row.started_at_revision === null ? {} : { startedAtRevision: row.started_at_revision }),
    ...(row.concluded_at_revision === null
      ? {}
      : { concludedAtRevision: row.concluded_at_revision }),
    meetingVersion: row.meeting_version,
    turnNumber: row.turn_number,
    participantIds: JSON.parse(row.participant_ids_json),
    chairCharacterId: row.chair_character_id,
    agendaItemIds: JSON.parse(row.agenda_item_ids_json),
    ...(row.current_agenda_item_id === null
      ? {}
      : { currentAgendaItemId: row.current_agenda_item_id }),
    ...(row.current_speaker_id === null ? {} : { currentSpeakerId: row.current_speaker_id }),
    ...(row.pending_player_action_json === null
      ? {}
      : { pendingPlayerAction: JSON.parse(row.pending_player_action_json) }),
    ...(row.pending_agent_action_json === null
      ? {}
      : { pendingAgentAction: JSON.parse(row.pending_agent_action_json) }),
    limits: JSON.parse(row.limits_json),
    usedTurns: row.used_turns,
    visibility: row.visibility,
    outcomeCandidateIds: JSON.parse(row.outcome_candidate_ids_json),
    ...(row.pause_reason === null ? {} : { pauseReason: row.pause_reason }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function sessionToParams(session: MeetingSessionState): SQLInputValue[] {
  return [
    session.meetingId,
    session.saveId,
    session.type,
    session.status,
    session.title,
    session.purpose,
    session.createdAtRevision,
    session.startedAtRevision ?? null,
    session.concludedAtRevision ?? null,
    session.meetingVersion,
    session.turnNumber,
    toJson(session.participantIds),
    session.chairCharacterId,
    toJson(session.agendaItemIds),
    session.currentAgendaItemId ?? null,
    session.currentSpeakerId ?? null,
    session.pendingPlayerAction ? toJson(session.pendingPlayerAction) : null,
    session.pendingAgentAction ? toJson(session.pendingAgentAction) : null,
    toJson(session.limits),
    session.usedTurns,
    session.visibility,
    toJson(session.outcomeCandidateIds),
    session.pauseReason ?? null,
    session.failureCode ?? null,
    session.createdAt,
    session.updatedAt,
  ];
}

const SESSION_COLUMNS = `meeting_id, save_id, type, status, title, purpose,
  created_at_revision, started_at_revision, concluded_at_revision,
  meeting_version, turn_number, participant_ids_json, chair_character_id,
  agenda_item_ids_json, current_agenda_item_id, current_speaker_id,
  pending_player_action_json, pending_agent_action_json, limits_json, used_turns,
  visibility, outcome_candidate_ids_json, pause_reason, failure_code,
  created_at, updated_at`;

export class MeetingRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** 原子创建会议（session + 参与者 + 议程） */
  createSession(
    session: MeetingSessionState,
    participants: readonly MeetingParticipantState[],
    agendaItems: readonly MeetingAgendaItem[],
  ): void {
    const parsed = MeetingSessionStateSchema.parse(session);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          `INSERT INTO meeting_sessions (${SESSION_COLUMNS})
           VALUES (${SESSION_COLUMNS.split(",").map(() => "?").join(", ")})`,
        )
        .run(...sessionToParams(parsed));
      for (const participant of participants) {
        this.upsertParticipant(participant);
      }
      for (const item of agendaItems) {
        this.upsertAgendaItem(item);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error instanceof SaveSystemError
        ? error
        : new SaveSystemError("DATABASE_ERROR", "创建会议失败", error);
    }
  }

  getSession(meetingId: string): MeetingSessionState | null {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM meeting_sessions WHERE meeting_id = ?`)
      .get(meetingId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  requireSession(meetingId: string): MeetingSessionState {
    const session = this.getSession(meetingId);
    if (!session) {
      throw new SaveSystemError("MEETING_NOT_FOUND", `会议不存在：${meetingId}`);
    }
    return session;
  }

  listSessions(saveId: string): MeetingSessionState[] {
    const rows = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM meeting_sessions WHERE save_id = ? ORDER BY created_at, meeting_id`,
      )
      .all(saveId) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  /** 乐观锁更新：expectedVersion 不符抛 MEETING_VERSION_STALE */
  updateSession(next: MeetingSessionState, expectedVersion: number): void {
    const parsed = MeetingSessionStateSchema.parse({
      ...next,
      updatedAt: this.clock.now().toISOString(),
    });
    const result = this.database
      .prepare(
        `UPDATE meeting_sessions SET
           status = ?, title = ?, purpose = ?,
           started_at_revision = ?, concluded_at_revision = ?,
           meeting_version = ?, turn_number = ?, participant_ids_json = ?,
           agenda_item_ids_json = ?, current_agenda_item_id = ?, current_speaker_id = ?,
           pending_player_action_json = ?, pending_agent_action_json = ?, limits_json = ?,
           used_turns = ?, outcome_candidate_ids_json = ?, pause_reason = ?, failure_code = ?,
           updated_at = ?
         WHERE meeting_id = ? AND meeting_version = ?`,
      )
      .run(
        parsed.status,
        parsed.title,
        parsed.purpose,
        parsed.startedAtRevision ?? null,
        parsed.concludedAtRevision ?? null,
        parsed.meetingVersion,
        parsed.turnNumber,
        toJson(parsed.participantIds),
        toJson(parsed.agendaItemIds),
        parsed.currentAgendaItemId ?? null,
        parsed.currentSpeakerId ?? null,
        parsed.pendingPlayerAction ? toJson(parsed.pendingPlayerAction) : null,
        parsed.pendingAgentAction ? toJson(parsed.pendingAgentAction) : null,
        toJson(parsed.limits),
        parsed.usedTurns,
        toJson(parsed.outcomeCandidateIds),
        parsed.pauseReason ?? null,
        parsed.failureCode ?? null,
        parsed.updatedAt,
        parsed.meetingId,
        expectedVersion,
      );
    if (Number(result.changes) === 0) {
      const current = this.getSession(parsed.meetingId);
      if (!current) {
        throw new SaveSystemError("MEETING_NOT_FOUND", `会议不存在：${parsed.meetingId}`);
      }
      throw new SaveSystemError(
        "MEETING_VERSION_STALE",
        `meetingVersion 过期：期望 ${expectedVersion}，当前 ${current.meetingVersion}`,
      );
    }
  }

  upsertParticipant(participant: MeetingParticipantState): void {
    const parsed = MeetingParticipantStateSchema.parse(participant);
    this.database
      .prepare(
        `INSERT OR REPLACE INTO meeting_participants (
           meeting_id, character_id, role, attendance, speaking_rights,
           turns_spoken, last_spoke_at_turn, requested_to_speak,
           granted_by_emperor_at_turn, challenged_character_ids_json,
           visible_until_turn, runtime_flags_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.meetingId,
        parsed.characterId,
        parsed.role,
        parsed.attendance,
        parsed.speakingRights,
        parsed.turnsSpoken,
        parsed.lastSpokeAtTurn ?? null,
        parsed.requestedToSpeak ? 1 : 0,
        parsed.grantedByEmperorAtTurn ?? null,
        toJson(parsed.challengedCharacterIds),
        parsed.visibleUntilTurn ?? null,
        toJson(parsed.runtimeFlags),
      );
  }

  listParticipants(meetingId: string): MeetingParticipantState[] {
    const rows = this.database
      .prepare("SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY character_id")
      .all(meetingId) as unknown as Array<Record<string, SQLInputValue>>;
    return rows.map((row) =>
      MeetingParticipantStateSchema.parse({
        meetingId: row.meeting_id,
        characterId: row.character_id,
        role: row.role,
        attendance: row.attendance,
        speakingRights: row.speaking_rights,
        turnsSpoken: Number(row.turns_spoken),
        ...(row.last_spoke_at_turn === null
          ? {}
          : { lastSpokeAtTurn: Number(row.last_spoke_at_turn) }),
        requestedToSpeak: Number(row.requested_to_speak) === 1,
        ...(row.granted_by_emperor_at_turn === null
          ? {}
          : { grantedByEmperorAtTurn: Number(row.granted_by_emperor_at_turn) }),
        challengedCharacterIds: JSON.parse(String(row.challenged_character_ids_json)),
        ...(row.visible_until_turn === null
          ? {}
          : { visibleUntilTurn: Number(row.visible_until_turn) }),
        runtimeFlags: JSON.parse(String(row.runtime_flags_json)),
      }),
    );
  }

  upsertAgendaItem(item: MeetingAgendaItem): void {
    const parsed = MeetingAgendaItemSchema.parse(item);
    this.database
      .prepare(
        `INSERT OR REPLACE INTO meeting_agenda_items (
           agenda_item_id, meeting_id, title, description, topic_ids_json, proposer_id,
           status, priority, sequence, max_turns, used_turns,
           related_entity_ids_json, required_office_ids_json, visibility
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.agendaItemId,
        parsed.meetingId,
        parsed.title,
        parsed.description,
        toJson(parsed.topicIds),
        parsed.proposerId,
        parsed.status,
        parsed.priority,
        parsed.sequence,
        parsed.maxTurns,
        parsed.usedTurns,
        toJson(parsed.relatedEntityIds),
        toJson(parsed.requiredOfficeIds),
        parsed.visibility,
      );
  }

  listAgendaItems(meetingId: string): MeetingAgendaItem[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM meeting_agenda_items WHERE meeting_id = ? ORDER BY sequence, agenda_item_id",
      )
      .all(meetingId) as unknown as Array<Record<string, SQLInputValue>>;
    return rows.map((row) =>
      MeetingAgendaItemSchema.parse({
        agendaItemId: row.agenda_item_id,
        meetingId: row.meeting_id,
        title: row.title,
        description: row.description,
        topicIds: JSON.parse(String(row.topic_ids_json)),
        proposerId: row.proposer_id,
        status: row.status,
        priority: Number(row.priority),
        sequence: Number(row.sequence),
        maxTurns: Number(row.max_turns),
        usedTurns: Number(row.used_turns),
        relatedEntityIds: JSON.parse(String(row.related_entity_ids_json)),
        requiredOfficeIds: JSON.parse(String(row.required_office_ids_json)),
        visibility: row.visibility,
      }),
    );
  }

  /** append-only 回合写入；同 actionId / 同 turnNumber 重复 → 幂等错误 */
  appendTurn(turn: MeetingTurnRecord): void {
    const parsed = MeetingTurnRecordSchema.parse(turn);
    try {
      this.database
        .prepare(
          `INSERT INTO meeting_turns (
             turn_id, meeting_id, save_id, agenda_item_id, turn_number, type, speaker_id,
             addressed_character_ids_json, public_text, private_metadata_json, visibility,
             state_revision, meeting_version, action_id, source_turn_ids_json,
             prompt_versions_json, provider_trace_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.turnId,
          parsed.meetingId,
          parsed.saveId,
          parsed.agendaItemId ?? null,
          parsed.turnNumber,
          parsed.type,
          parsed.speakerId,
          toJson(parsed.addressedCharacterIds),
          parsed.publicText,
          parsed.privateMetadata ? toJson(parsed.privateMetadata) : null,
          parsed.visibility,
          parsed.stateRevision,
          parsed.meetingVersion,
          parsed.actionId ?? null,
          toJson(parsed.sourceTurnIds),
          parsed.promptVersions ? toJson(parsed.promptVersions) : null,
          parsed.providerTrace ? toJson(parsed.providerTrace) : null,
          parsed.createdAt,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE")) {
        throw new SaveSystemError(
          "MEETING_AGENT_RESPONSE_DUPLICATE",
          `会议回合重复写入：turn ${parsed.turnNumber} / action ${parsed.actionId ?? "-"}`,
        );
      }
      throw new SaveSystemError("MEETING_TRANSCRIPT_WRITE_FAILED", "会议记录写入失败", error);
    }
  }

  hasTurnForAction(actionId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM meeting_turns WHERE action_id = ?")
        .get(actionId) !== undefined
    );
  }

  listTurns(
    meetingId: string,
    filter: TurnListFilter = {},
  ): { turns: MeetingTurnRecord[]; nextCursor: number | null } {
    const conditions = ["meeting_id = ?"];
    const parameters: SQLInputValue[] = [meetingId];
    if (filter.agendaItemId) {
      conditions.push("agenda_item_id = ?");
      parameters.push(filter.agendaItemId);
    }
    if (filter.speakerId) {
      conditions.push("speaker_id = ?");
      parameters.push(filter.speakerId);
    }
    if (filter.maxVisibility) {
      const allowed = (Object.keys(VISIBILITY_RANK) as MeetingVisibility[]).filter(
        (level) => VISIBILITY_RANK[level] <= VISIBILITY_RANK[filter.maxVisibility!],
      );
      conditions.push(`visibility IN (${allowed.map(() => "?").join(", ")})`);
      parameters.push(...allowed);
    }
    if (filter.cursor !== undefined) {
      conditions.push("turn_number > ?");
      parameters.push(filter.cursor);
    }
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows = this.database
      .prepare(
        `SELECT * FROM meeting_turns WHERE ${conditions.join(" AND ")}
         ORDER BY turn_number ASC LIMIT ?`,
      )
      .all(...parameters, limit) as unknown as Array<Record<string, SQLInputValue>>;
    const turns = rows.map((row) =>
      MeetingTurnRecordSchema.parse({
        turnId: row.turn_id,
        meetingId: row.meeting_id,
        saveId: row.save_id,
        ...(row.agenda_item_id === null ? {} : { agendaItemId: row.agenda_item_id }),
        turnNumber: Number(row.turn_number),
        type: row.type,
        speakerId: row.speaker_id,
        addressedCharacterIds: JSON.parse(String(row.addressed_character_ids_json)),
        publicText: row.public_text,
        ...(row.private_metadata_json === null
          ? {}
          : { privateMetadata: JSON.parse(String(row.private_metadata_json)) }),
        visibility: row.visibility,
        stateRevision: Number(row.state_revision),
        meetingVersion: Number(row.meeting_version),
        ...(row.action_id === null ? {} : { actionId: row.action_id }),
        sourceTurnIds: JSON.parse(String(row.source_turn_ids_json)),
        ...(row.prompt_versions_json === null
          ? {}
          : { promptVersions: JSON.parse(String(row.prompt_versions_json)) }),
        ...(row.provider_trace_json === null
          ? {}
          : { providerTrace: JSON.parse(String(row.provider_trace_json)) }),
        createdAt: row.created_at,
      }),
    );
    return {
      turns,
      nextCursor: turns.length === limit ? (turns.at(-1)?.turnNumber ?? null) : null,
    };
  }

  /**
   * 两阶段提交·阶段 B（ADR-020）：校验 pending 匹配后，原子地
   * 追加回合 + 更新会议 head；重复 actionId 幂等拒绝。
   */
  commitAgentTurn(
    turn: MeetingTurnRecord,
    nextSession: MeetingSessionState,
    expectedVersion: number,
  ): void {
    const current = this.requireSession(turn.meetingId);
    if (
      !current.pendingAgentAction ||
      current.pendingAgentAction.actionId !== turn.actionId
    ) {
      if (turn.actionId && this.hasTurnForAction(turn.actionId)) {
        throw new SaveSystemError(
          "MEETING_AGENT_RESPONSE_DUPLICATE",
          `该 Agent 回合已提交过：${turn.actionId}`,
        );
      }
      throw new SaveSystemError(
        "MEETING_VERSION_STALE",
        `会议未在等待该 Agent 回合：${turn.actionId ?? "-"}`,
      );
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.appendTurn(turn);
      this.updateSession(nextSession, expectedVersion);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error instanceof SaveSystemError
        ? error
        : new SaveSystemError("MEETING_TRANSCRIPT_WRITE_FAILED", "Agent 回合提交失败", error);
    }
  }

  insertOutcomeCandidate(candidate: MeetingOutcomeCandidate): void {
    const parsed = MeetingOutcomeCandidateSchema.parse(candidate);
    this.database
      .prepare(
        `INSERT INTO meeting_outcome_candidates (
           outcome_candidate_id, meeting_id, save_id, agenda_item_id, type, title, summary,
           proposer_ids_json, supporter_ids_json, opponent_ids_json, rationale_json, risks_json,
           source_turn_ids_json, status, command_preview_json, unsupported_command,
           created_at_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.outcomeCandidateId,
        parsed.meetingId,
        parsed.saveId,
        parsed.agendaItemId,
        parsed.type,
        parsed.title,
        parsed.summary,
        toJson(parsed.proposerIds),
        toJson(parsed.supporterIds),
        toJson(parsed.opponentIds),
        toJson(parsed.rationale),
        toJson(parsed.risks),
        toJson(parsed.sourceTurnIds),
        parsed.status,
        parsed.commandPreview ? toJson(parsed.commandPreview) : null,
        parsed.unsupportedCommand ? 1 : 0,
        parsed.createdAtRevision,
        parsed.createdAt,
      );
  }

  updateOutcomeStatus(
    outcomeCandidateId: string,
    status: MeetingOutcomeCandidate["status"],
  ): void {
    const result = this.database
      .prepare("UPDATE meeting_outcome_candidates SET status = ? WHERE outcome_candidate_id = ?")
      .run(status, outcomeCandidateId);
    if (Number(result.changes) === 0) {
      throw new SaveSystemError("MEETING_NOT_FOUND", `结果候选不存在：${outcomeCandidateId}`);
    }
  }

  listOutcomeCandidates(meetingId: string): MeetingOutcomeCandidate[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM meeting_outcome_candidates WHERE meeting_id = ? ORDER BY created_at, outcome_candidate_id",
      )
      .all(meetingId) as unknown as Array<Record<string, SQLInputValue>>;
    return rows.map((row) =>
      MeetingOutcomeCandidateSchema.parse({
        outcomeCandidateId: row.outcome_candidate_id,
        meetingId: row.meeting_id,
        saveId: row.save_id,
        agendaItemId: row.agenda_item_id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        proposerIds: JSON.parse(String(row.proposer_ids_json)),
        supporterIds: JSON.parse(String(row.supporter_ids_json)),
        opponentIds: JSON.parse(String(row.opponent_ids_json)),
        rationale: JSON.parse(String(row.rationale_json)),
        risks: JSON.parse(String(row.risks_json)),
        sourceTurnIds: JSON.parse(String(row.source_turn_ids_json)),
        status: row.status,
        ...(row.command_preview_json === null
          ? {}
          : { commandPreview: JSON.parse(String(row.command_preview_json)) }),
        unsupportedCommand: Number(row.unsupported_command) === 1,
        createdAtRevision: Number(row.created_at_revision),
        createdAt: row.created_at,
      }),
    );
  }

  insertMinutes(minutes: MeetingMinutes): void {
    const parsed = MeetingMinutesSchema.parse(minutes);
    this.database
      .prepare(
        `INSERT INTO meeting_minutes (
           minutes_id, meeting_id, save_id, kind, audience_character_ids_json, title,
           participant_ids_json, entries_json, accepted_outcome_candidate_ids_json,
           deferred_agenda_item_ids_json, state_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.minutesId,
        parsed.meetingId,
        parsed.saveId,
        parsed.kind,
        toJson(parsed.audienceCharacterIds),
        parsed.title,
        toJson(parsed.participantIds),
        toJson(parsed.entries),
        toJson(parsed.acceptedOutcomeCandidateIds),
        toJson(parsed.deferredAgendaItemIds),
        parsed.stateRevision,
        parsed.createdAt,
      );
  }

  /** private 纪要只返回给授权角色；characterId 缺省 = 仅 official */
  listMinutes(meetingId: string, characterId?: string): MeetingMinutes[] {
    const rows = this.database
      .prepare("SELECT * FROM meeting_minutes WHERE meeting_id = ? ORDER BY kind, minutes_id")
      .all(meetingId) as unknown as Array<Record<string, SQLInputValue>>;
    return rows
      .map((row) =>
        MeetingMinutesSchema.parse({
          minutesId: row.minutes_id,
          meetingId: row.meeting_id,
          saveId: row.save_id,
          kind: row.kind,
          audienceCharacterIds: JSON.parse(String(row.audience_character_ids_json)),
          title: row.title,
          participantIds: JSON.parse(String(row.participant_ids_json)),
          entries: JSON.parse(String(row.entries_json)),
          acceptedOutcomeCandidateIds: JSON.parse(
            String(row.accepted_outcome_candidate_ids_json),
          ),
          deferredAgendaItemIds: JSON.parse(String(row.deferred_agenda_item_ids_json)),
          stateRevision: Number(row.state_revision),
          createdAt: row.created_at,
        }),
      )
      .filter(
        (minutes) =>
          minutes.kind === "official" ||
          (characterId !== undefined && minutes.audienceCharacterIds.includes(characterId)),
      );
  }

  insertLeakAssessment(assessment: MeetingLeakAssessment): void {
    const parsed = MeetingLeakAssessmentSchema.parse(assessment);
    this.database
      .prepare(
        `INSERT OR REPLACE INTO meeting_leak_assessments (
           meeting_id, save_id, risk_score, risk_level, contributing_factors_json,
           deterministic_roll_json, potential_audience_ids_json, created_at_revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.meetingId,
        parsed.saveId,
        parsed.riskScore,
        parsed.riskLevel,
        toJson(parsed.contributingFactors),
        parsed.deterministicRoll ? toJson(parsed.deterministicRoll) : null,
        toJson(parsed.potentialAudienceIds),
        parsed.createdAtRevision,
        parsed.createdAt,
      );
  }

  getLeakAssessment(meetingId: string): MeetingLeakAssessment | null {
    const row = this.database
      .prepare("SELECT * FROM meeting_leak_assessments WHERE meeting_id = ?")
      .get(meetingId) as Record<string, SQLInputValue> | undefined;
    if (!row) return null;
    return MeetingLeakAssessmentSchema.parse({
      meetingId: row.meeting_id,
      saveId: row.save_id,
      riskScore: Number(row.risk_score),
      riskLevel: row.risk_level,
      contributingFactors: JSON.parse(String(row.contributing_factors_json)),
      ...(row.deterministic_roll_json === null
        ? {}
        : { deterministicRoll: JSON.parse(String(row.deterministic_roll_json)) }),
      potentialAudienceIds: JSON.parse(String(row.potential_audience_ids_json)),
      createdAtRevision: Number(row.created_at_revision),
      createdAt: row.created_at,
    });
  }

  /** 恢复辅助：找出仍有 pending Agent 回合的会议（服务重启后处理） */
  findPendingAgentSessions(saveId: string): MeetingSessionState[] {
    const rows = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM meeting_sessions
         WHERE save_id = ? AND pending_agent_action_json IS NOT NULL`,
      )
      .all(saveId) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }
}
