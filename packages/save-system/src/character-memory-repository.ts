import {
  CharacterConversationTurnSchema,
  CharacterMemorySchema,
  type CharacterConversationTurn,
  type CharacterMemory,
  type CharacterMemoryCandidate,
  type MemoryStatus,
} from "@mandate/domain";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "@mandate/game-engine";
import { SaveSystemError } from "./errors";

/**
 * 人物记忆与对话记录仓储（ADR-012）。
 * 唯一的记忆写入口：Agent 只能产出候选，经 Memory Policy 审批后由
 * Application Service 调用本仓储落库。写入不产生 StateChangeLog。
 */

export interface InsertMemoryInput {
  readonly saveId: string;
  readonly characterId: string;
  readonly candidate: CharacterMemoryCandidate;
  /** Memory Policy 收敛后的可信度 */
  readonly confidence: number;
  readonly sourceRevision: number;
  readonly sourceTxId?: string;
  readonly sourceMeetingId?: string;
  readonly sourceCommandId?: string;
}

export interface MemoryListFilter {
  readonly type?: CharacterMemory["type"];
  readonly status?: MemoryStatus;
  readonly topic?: string;
  readonly relatedCharacterId?: string;
  readonly fromRevision?: number;
  readonly toRevision?: number;
  readonly limit?: number;
  readonly cursor?: number;
}

interface MemoryRow {
  memory_id: string;
  save_id: string;
  character_id: string;
  type: CharacterMemory["type"];
  content: string;
  structured_content_json: string | null;
  related_character_ids_json: string;
  related_entity_ids_json: string;
  topic_tags_json: string;
  source_revision: number;
  source_tx_id: string | null;
  source_meeting_id: string | null;
  source_command_id: string | null;
  source_type: CharacterMemory["sourceType"];
  confidence: number;
  importance: number;
  visibility: CharacterMemory["visibility"];
  status: MemoryStatus;
  created_at: string;
  last_recalled_at: string | null;
  recall_count: number;
  rowid: number;
}

interface TurnRow {
  turn_id: string;
  save_id: string;
  character_id: string;
  speaker_id: string;
  mode: CharacterConversationTurn["mode"];
  input_text: string;
  speech: string;
  state_revision: number;
  prompt_versions_json: string;
  created_at: string;
}

function rowToMemory(row: MemoryRow): CharacterMemory {
  return CharacterMemorySchema.parse({
    memoryId: row.memory_id,
    saveId: row.save_id,
    characterId: row.character_id,
    type: row.type,
    content: row.content,
    ...(row.structured_content_json === null
      ? {}
      : { structuredContent: JSON.parse(row.structured_content_json) }),
    relatedCharacterIds: JSON.parse(row.related_character_ids_json),
    relatedEntityIds: JSON.parse(row.related_entity_ids_json),
    topicTags: JSON.parse(row.topic_tags_json),
    sourceRevision: row.source_revision,
    ...(row.source_tx_id === null ? {} : { sourceTxId: row.source_tx_id }),
    ...(row.source_meeting_id === null ? {} : { sourceMeetingId: row.source_meeting_id }),
    ...(row.source_command_id === null ? {} : { sourceCommandId: row.source_command_id }),
    sourceType: row.source_type,
    confidence: row.confidence,
    importance: row.importance,
    visibility: row.visibility,
    status: row.status,
    createdAt: row.created_at,
    ...(row.last_recalled_at === null ? {} : { lastRecalledAt: row.last_recalled_at }),
    recallCount: row.recall_count,
  });
}

export class CharacterMemoryRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock,
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  insertMemory(input: InsertMemoryInput): CharacterMemory {
    const memory: CharacterMemory = CharacterMemorySchema.parse({
      memoryId: `mem_${this.idFactory()}`,
      saveId: input.saveId,
      characterId: input.characterId,
      type: input.candidate.type,
      content: input.candidate.content,
      ...(input.candidate.structuredContent === undefined
        ? {}
        : { structuredContent: input.candidate.structuredContent }),
      relatedCharacterIds: input.candidate.relatedCharacterIds,
      relatedEntityIds: input.candidate.relatedEntityIds,
      topicTags: input.candidate.topicTags,
      sourceRevision: input.sourceRevision,
      ...(input.sourceTxId === undefined ? {} : { sourceTxId: input.sourceTxId }),
      ...(input.sourceMeetingId === undefined ? {} : { sourceMeetingId: input.sourceMeetingId }),
      ...(input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId }),
      sourceType: input.candidate.sourceType,
      confidence: input.confidence,
      importance: input.candidate.importance,
      visibility: input.candidate.visibility,
      status: "active",
      createdAt: this.clock.now().toISOString(),
      recallCount: 0,
    });
    try {
      this.database
        .prepare(
          `INSERT INTO character_memories (
             memory_id, save_id, character_id, type, content, structured_content_json,
             related_character_ids_json, related_entity_ids_json, topic_tags_json,
             source_revision, source_tx_id, source_meeting_id, source_command_id,
             source_type, confidence, importance, visibility, status,
             created_at, last_recalled_at, recall_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.memoryId,
          memory.saveId,
          memory.characterId,
          memory.type,
          memory.content,
          memory.structuredContent === undefined ? null : JSON.stringify(memory.structuredContent),
          JSON.stringify(memory.relatedCharacterIds),
          JSON.stringify(memory.relatedEntityIds),
          JSON.stringify(memory.topicTags),
          memory.sourceRevision,
          memory.sourceTxId ?? null,
          memory.sourceMeetingId ?? null,
          memory.sourceCommandId ?? null,
          memory.sourceType,
          memory.confidence,
          memory.importance,
          memory.visibility,
          memory.status,
          memory.createdAt,
          null,
          memory.recallCount,
        );
    } catch (error) {
      throw new SaveSystemError("DATABASE_ERROR", "写入人物记忆失败", error);
    }
    return memory;
  }

  listMemories(
    saveId: string,
    characterId: string,
    filter: MemoryListFilter = {},
  ): { memories: CharacterMemory[]; nextCursor: number | null } {
    const conditions = ["save_id = ?", "character_id = ?"];
    const parameters: (string | number)[] = [saveId, characterId];
    if (filter.type) {
      conditions.push("type = ?");
      parameters.push(filter.type);
    }
    if (filter.status) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    if (filter.topic) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(topic_tags_json) WHERE value = ?)");
      parameters.push(filter.topic);
    }
    if (filter.relatedCharacterId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(related_character_ids_json) WHERE value = ?)",
      );
      parameters.push(filter.relatedCharacterId);
    }
    if (filter.fromRevision !== undefined) {
      conditions.push("source_revision >= ?");
      parameters.push(filter.fromRevision);
    }
    if (filter.toRevision !== undefined) {
      conditions.push("source_revision <= ?");
      parameters.push(filter.toRevision);
    }
    if (filter.cursor !== undefined) {
      conditions.push("rowid > ?");
      parameters.push(filter.cursor);
    }
    const limit = Math.min(filter.limit ?? 100, 200);
    const rows = this.database
      .prepare(
        `SELECT *, rowid FROM character_memories
         WHERE ${conditions.join(" AND ")}
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(...parameters, limit) as unknown as MemoryRow[];
    return {
      memories: rows.map(rowToMemory),
      nextCursor: rows.length === limit ? (rows.at(-1)?.rowid ?? null) : null,
    };
  }

  countActiveMemories(saveId: string, characterId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM character_memories
         WHERE save_id = ? AND character_id = ? AND status != 'forgotten'`,
      )
      .get(saveId, characterId) as { total: number };
    return Number(row.total);
  }

  touchRecall(memoryIds: readonly string[]): void {
    if (memoryIds.length === 0) return;
    const now = this.clock.now().toISOString();
    const statement = this.database.prepare(
      `UPDATE character_memories
       SET last_recalled_at = ?, recall_count = recall_count + 1
       WHERE memory_id = ?`,
    );
    for (const memoryId of memoryIds) {
      statement.run(now, memoryId);
    }
  }

  markStatus(memoryId: string, status: MemoryStatus): void {
    const result = this.database
      .prepare("UPDATE character_memories SET status = ? WHERE memory_id = ?")
      .run(status, memoryId);
    if (Number(result.changes) === 0) {
      throw new SaveSystemError("DATABASE_ERROR", `记忆不存在：${memoryId}`);
    }
  }

  insertTurn(turn: Omit<CharacterConversationTurn, "turnId" | "createdAt">): CharacterConversationTurn {
    const record = CharacterConversationTurnSchema.parse({
      ...turn,
      turnId: `turn_${this.idFactory()}`,
      createdAt: this.clock.now().toISOString(),
    });
    try {
      this.database
        .prepare(
          `INSERT INTO character_conversation_turns (
             turn_id, save_id, character_id, speaker_id, mode,
             input_text, speech, state_revision, prompt_versions_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.turnId,
          record.saveId,
          record.characterId,
          record.speakerId,
          record.mode,
          record.inputText,
          record.speech,
          record.stateRevision,
          JSON.stringify(record.promptVersions),
          record.createdAt,
        );
    } catch (error) {
      throw new SaveSystemError("DATABASE_ERROR", "写入对话记录失败", error);
    }
    return record;
  }

  listRecentTurns(
    saveId: string,
    characterId: string,
    limit = 10,
  ): CharacterConversationTurn[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM character_conversation_turns
         WHERE save_id = ? AND character_id = ?
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(saveId, characterId, Math.min(limit, 50)) as unknown as TurnRow[];
    return rows.reverse().map((row) =>
      CharacterConversationTurnSchema.parse({
        turnId: row.turn_id,
        saveId: row.save_id,
        characterId: row.character_id,
        speakerId: row.speaker_id,
        mode: row.mode,
        inputText: row.input_text,
        speech: row.speech,
        stateRevision: row.state_revision,
        promptVersions: JSON.parse(row.prompt_versions_json),
        createdAt: row.created_at,
      }),
    );
  }
}
