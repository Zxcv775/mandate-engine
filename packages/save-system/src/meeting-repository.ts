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
import { currentTimelineRevisionPredicate } from "./timeline";

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

export interface MeetingRulingRecord {
  readonly rulingId: string;
  readonly saveId: string;
  readonly meetingId: string;
  readonly agendaItemId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly stateRevision: number;
  readonly result: unknown;
  readonly createdAt: string;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function jsonToSession(value: string): MeetingSessionState {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  for (const key of [
    "startedAtRevision",
    "concludedAtRevision",
    "currentAgendaItemId",
    "currentSpeakerId",
    "pendingPlayerAction",
    "pendingAgentAction",
    "pauseReason",
    "failureCode",
  ]) {
    if (parsed[key] === null) delete parsed[key];
  }
  return MeetingSessionStateSchema.parse(parsed);
}

function versionObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  for (const [key, item] of Object.entries(parsed)) {
    if (item === null) delete parsed[key];
  }
  return parsed;
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

  private meetingSaveId(meetingId: string): string {
    const row = this.database
      .prepare("SELECT save_id FROM meeting_sessions WHERE meeting_id = ?")
      .get(meetingId) as { save_id: string } | undefined;
    if (!row) throw new SaveSystemError("MEETING_NOT_FOUND", `会议不存在：${meetingId}`);
    return row.save_id;
  }

  private headRevision(saveId: string): number {
    const row = this.database
      .prepare("SELECT head_revision FROM saves WHERE save_id = ?")
      .get(saveId) as { head_revision: number } | undefined;
    if (!row) throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
    return Number(row.head_revision);
  }

  private insertSessionVersion(session: MeetingSessionState): void {
    this.database
      .prepare(
        `INSERT INTO meeting_session_versions (
           meeting_id, save_id, state_revision, meeting_version, session_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.meetingId,
        session.saveId,
        this.headRevision(session.saveId),
        session.meetingVersion,
        toJson(session),
        this.clock.now().toISOString(),
      );
  }

  /** 原子创建会议（session + 参与者 + 议程） */
  createSession(
    session: MeetingSessionState,
    participants: readonly MeetingParticipantState[],
    agendaItems: readonly MeetingAgendaItem[],
  ): void {
    const parsed = MeetingSessionStateSchema.parse(session);
    const ownsTransaction = !this.database.isTransaction;
    try {
      if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          `INSERT INTO meeting_sessions (${SESSION_COLUMNS})
           VALUES (${SESSION_COLUMNS.split(",")
             .map(() => "?")
             .join(", ")})`,
        )
        .run(...sessionToParams(parsed));
      for (const participant of participants) {
        this.upsertParticipant(participant);
      }
      for (const item of agendaItems) {
        this.upsertAgendaItem(item);
      }
      this.insertSessionVersion(parsed);
      if (ownsTransaction) this.database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error instanceof SaveSystemError
        ? error
        : new SaveSystemError("DATABASE_ERROR", "创建会议失败", error);
    }
  }

  getSession(meetingId: string): MeetingSessionState | null {
    const row = this.database
      .prepare(
        `SELECT session_json FROM meeting_session_versions
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_session_versions.save_id",
             "meeting_session_versions.state_revision",
           )}
         ORDER BY state_revision DESC, meeting_version DESC
         LIMIT 1`,
      )
      .get(meetingId) as { session_json: string } | undefined;
    return row ? jsonToSession(row.session_json) : null;
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
        `SELECT meeting_id, session_json FROM meeting_session_versions
         WHERE save_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_session_versions.save_id",
             "meeting_session_versions.state_revision",
           )}
         ORDER BY meeting_id, state_revision DESC, meeting_version DESC`,
      )
      .all(saveId) as unknown as Array<{ meeting_id: string; session_json: string }>;
    const sessions = new Map<string, MeetingSessionState>();
    for (const row of rows) {
      if (!sessions.has(row.meeting_id))
        sessions.set(row.meeting_id, jsonToSession(row.session_json));
    }
    return [...sessions.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.meetingId.localeCompare(right.meetingId),
    );
  }

  /** 乐观锁更新：expectedVersion 不符抛 MEETING_VERSION_STALE */
  updateSession(next: MeetingSessionState, expectedVersion: number): void {
    const parsed = MeetingSessionStateSchema.parse({
      ...next,
      updatedAt: this.clock.now().toISOString(),
    });
    const ownsTransaction = !this.database.isTransaction;
    try {
      if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
      const current = this.getSession(parsed.meetingId);
      if (!current) {
        throw new SaveSystemError("MEETING_NOT_FOUND", `会议不存在：${parsed.meetingId}`);
      }
      if (current.meetingVersion !== expectedVersion) {
        throw new SaveSystemError(
          "MEETING_VERSION_STALE",
          `meetingVersion 过期：期望 ${expectedVersion}，当前 ${current.meetingVersion}`,
        );
      }
      this.database
        .prepare(
          `UPDATE meeting_sessions SET
           status = ?, title = ?, purpose = ?,
           started_at_revision = ?, concluded_at_revision = ?,
           meeting_version = ?, turn_number = ?, participant_ids_json = ?,
           agenda_item_ids_json = ?, current_agenda_item_id = ?, current_speaker_id = ?,
           pending_player_action_json = ?, pending_agent_action_json = ?, limits_json = ?,
           used_turns = ?, outcome_candidate_ids_json = ?, pause_reason = ?, failure_code = ?,
           updated_at = ?
         WHERE meeting_id = ?`,
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
        );
      this.insertSessionVersion(parsed);
      if (ownsTransaction) this.database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertParticipant(participant: MeetingParticipantState): void {
    const parsed = MeetingParticipantStateSchema.parse(participant);
    const saveId = this.meetingSaveId(parsed.meetingId);
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
    this.database
      .prepare(
        `INSERT INTO meeting_participant_versions (
           meeting_id, save_id, character_id, state_revision, entity_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.meetingId,
        saveId,
        parsed.characterId,
        this.headRevision(saveId),
        toJson(parsed),
        this.clock.now().toISOString(),
      );
  }

  listParticipants(meetingId: string): MeetingParticipantState[] {
    const rows = this.database
      .prepare(
        `SELECT character_id, entity_json FROM meeting_participant_versions
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_participant_versions.save_id",
             "meeting_participant_versions.state_revision",
           )}
         ORDER BY character_id, state_revision DESC, version_id DESC`,
      )
      .all(meetingId) as unknown as Array<{ character_id: string; entity_json: string }>;
    const participants = new Map<string, MeetingParticipantState>();
    for (const row of rows) {
      if (!participants.has(row.character_id)) {
        participants.set(
          row.character_id,
          MeetingParticipantStateSchema.parse(versionObject(row.entity_json)),
        );
      }
    }
    return [...participants.values()].sort((left, right) =>
      left.characterId < right.characterId ? -1 : left.characterId > right.characterId ? 1 : 0,
    );
  }

  upsertAgendaItem(item: MeetingAgendaItem): void {
    const parsed = MeetingAgendaItemSchema.parse(item);
    const saveId = this.meetingSaveId(parsed.meetingId);
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
    this.database
      .prepare(
        `INSERT INTO meeting_agenda_item_versions (
           meeting_id, save_id, agenda_item_id, state_revision, entity_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.meetingId,
        saveId,
        parsed.agendaItemId,
        this.headRevision(saveId),
        toJson(parsed),
        this.clock.now().toISOString(),
      );
  }

  listAgendaItems(meetingId: string): MeetingAgendaItem[] {
    const rows = this.database
      .prepare(
        `SELECT agenda_item_id, entity_json FROM meeting_agenda_item_versions
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_agenda_item_versions.save_id",
             "meeting_agenda_item_versions.state_revision",
           )}
         ORDER BY agenda_item_id, state_revision DESC, version_id DESC`,
      )
      .all(meetingId) as unknown as Array<{ agenda_item_id: string; entity_json: string }>;
    const agendaItems = new Map<string, MeetingAgendaItem>();
    for (const row of rows) {
      if (!agendaItems.has(row.agenda_item_id)) {
        agendaItems.set(
          row.agenda_item_id,
          MeetingAgendaItemSchema.parse(versionObject(row.entity_json)),
        );
      }
    }
    return [...agendaItems.values()].sort(
      (left, right) =>
        left.sequence - right.sequence ||
        (left.agendaItemId < right.agendaItemId
          ? -1
          : left.agendaItemId > right.agendaItemId
            ? 1
            : 0),
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
        .prepare(
          `SELECT 1 FROM meeting_turns
           WHERE action_id = ?
             AND ${currentTimelineRevisionPredicate(
               "meeting_turns.save_id",
               "meeting_turns.state_revision",
             )}`,
        )
        .get(actionId) !== undefined
    );
  }

  listTurns(
    meetingId: string,
    filter: TurnListFilter = {},
  ): { turns: MeetingTurnRecord[]; nextCursor: number | null } {
    const conditions = [
      "meeting_id = ?",
      currentTimelineRevisionPredicate("meeting_turns.save_id", "meeting_turns.state_revision"),
    ];
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
    if (!current.pendingAgentAction || current.pendingAgentAction.actionId !== turn.actionId) {
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
    const ownsTransaction = !this.database.isTransaction;
    try {
      if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
      this.appendTurn(turn);
      this.updateSession(nextSession, expectedVersion);
      if (ownsTransaction) this.database.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
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
    this.insertOutcomeCandidateVersion(parsed);
  }

  private insertOutcomeCandidateVersion(candidate: MeetingOutcomeCandidate): void {
    this.database
      .prepare(
        `INSERT INTO meeting_outcome_candidate_versions (
           meeting_id, save_id, outcome_candidate_id, state_revision, entity_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.meetingId,
        candidate.saveId,
        candidate.outcomeCandidateId,
        this.headRevision(candidate.saveId),
        toJson(candidate),
        this.clock.now().toISOString(),
      );
  }

  updateOutcomeStatus(outcomeCandidateId: string, status: MeetingOutcomeCandidate["status"]): void {
    const current = this.database
      .prepare(
        `SELECT entity_json FROM meeting_outcome_candidate_versions
         WHERE outcome_candidate_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_outcome_candidate_versions.save_id",
             "meeting_outcome_candidate_versions.state_revision",
           )}
         ORDER BY state_revision DESC, version_id DESC LIMIT 1`,
      )
      .get(outcomeCandidateId) as { entity_json: string } | undefined;
    if (!current) {
      throw new SaveSystemError("MEETING_NOT_FOUND", `结果候选不存在：${outcomeCandidateId}`);
    }
    const candidate = MeetingOutcomeCandidateSchema.parse(versionObject(current.entity_json));
    const result = this.database
      .prepare("UPDATE meeting_outcome_candidates SET status = ? WHERE outcome_candidate_id = ?")
      .run(status, outcomeCandidateId);
    if (Number(result.changes) === 0) {
      throw new SaveSystemError("MEETING_NOT_FOUND", `结果候选不存在：${outcomeCandidateId}`);
    }
    this.insertOutcomeCandidateVersion({ ...candidate, status });
  }

  listOutcomeCandidates(meetingId: string): MeetingOutcomeCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT outcome_candidate_id, entity_json FROM meeting_outcome_candidate_versions
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_outcome_candidate_versions.save_id",
             "meeting_outcome_candidate_versions.state_revision",
           )}
         ORDER BY outcome_candidate_id, state_revision DESC, version_id DESC`,
      )
      .all(meetingId) as unknown as Array<{
      outcome_candidate_id: string;
      entity_json: string;
    }>;
    const candidates = new Map<string, MeetingOutcomeCandidate>();
    for (const row of rows) {
      if (!candidates.has(row.outcome_candidate_id)) {
        candidates.set(
          row.outcome_candidate_id,
          MeetingOutcomeCandidateSchema.parse(versionObject(row.entity_json)),
        );
      }
    }
    return [...candidates.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        (left.outcomeCandidateId < right.outcomeCandidateId
          ? -1
          : left.outcomeCandidateId > right.outcomeCandidateId
            ? 1
            : 0),
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
      .prepare(
        `SELECT * FROM meeting_minutes
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_minutes.save_id",
             "meeting_minutes.state_revision",
           )}
         ORDER BY kind, minutes_id`,
      )
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
          acceptedOutcomeCandidateIds: JSON.parse(String(row.accepted_outcome_candidate_ids_json)),
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
    this.database
      .prepare(
        `INSERT INTO meeting_leak_assessment_versions (
           meeting_id, save_id, state_revision, entity_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.meetingId,
        parsed.saveId,
        this.headRevision(parsed.saveId),
        toJson(parsed),
        this.clock.now().toISOString(),
      );
  }

  getLeakAssessment(meetingId: string): MeetingLeakAssessment | null {
    const row = this.database
      .prepare(
        `SELECT entity_json FROM meeting_leak_assessment_versions
         WHERE meeting_id = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_leak_assessment_versions.save_id",
             "meeting_leak_assessment_versions.state_revision",
           )}
         ORDER BY state_revision DESC, version_id DESC LIMIT 1`,
      )
      .get(meetingId) as { entity_json: string } | undefined;
    if (!row) return null;
    return MeetingLeakAssessmentSchema.parse(versionObject(row.entity_json));
  }

  getRulingByIdempotencyKey(
    saveId: string,
    meetingId: string,
    idempotencyKey: string,
  ): MeetingRulingRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM meeting_rulings
         WHERE save_id = ? AND meeting_id = ? AND idempotency_key = ?
           AND ${currentTimelineRevisionPredicate(
             "meeting_rulings.save_id",
             "meeting_rulings.state_revision",
           )}
         ORDER BY state_revision DESC, ruling_id DESC
         LIMIT 1`,
      )
      .get(saveId, meetingId, idempotencyKey) as Record<string, SQLInputValue> | undefined;
    if (!row) return null;
    return {
      rulingId: String(row.ruling_id),
      saveId: String(row.save_id),
      meetingId: String(row.meeting_id),
      agendaItemId: String(row.agenda_item_id),
      idempotencyKey: String(row.idempotency_key),
      requestHash: String(row.request_hash),
      stateRevision: Number(row.state_revision),
      result: JSON.parse(String(row.result_json)),
      createdAt: String(row.created_at),
    };
  }

  insertRuling(record: MeetingRulingRecord): void {
    this.database
      .prepare(
        `INSERT INTO meeting_rulings (
           ruling_id, save_id, meeting_id, agenda_item_id, idempotency_key,
           request_hash, state_revision, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.rulingId,
        record.saveId,
        record.meetingId,
        record.agendaItemId,
        record.idempotencyKey,
        record.requestHash,
        record.stateRevision,
        toJson(record.result),
        record.createdAt,
      );
  }

  /** 恢复辅助：找出仍有 pending Agent 回合的会议（服务重启后处理） */
  findPendingAgentSessions(saveId: string): MeetingSessionState[] {
    return this.listSessions(saveId).filter((session) => session.pendingAgentAction !== undefined);
  }
}
