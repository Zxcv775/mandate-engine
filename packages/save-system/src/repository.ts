import {
  CheckpointMetadataSchema,
  GameStateSchema,
  SaveMetadataSchema,
  StateChangeLogEntrySchema,
  type CheckpointMetadata,
  type GameCommand,
  type GameState,
  type ProposedMutation,
  type SaveMetadata,
  type StateChangeLogEntry,
} from "@mandate/domain";
import {
  hashState,
  invertMutation,
  sha256Hex,
  stableStringify,
  applyMutations,
  type Clock,
  type StateTransition,
} from "@mandate/game-engine";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";
import { SaveSystemError } from "./errors";
import type {
  ChangeQuery,
  CheckpointInput,
  CommitResult,
  CommitTransitionOptions,
  CreateSaveRecordInput,
  RepositoryOptions,
  RowCounts,
  SaveRepositoryContract,
} from "./types";

interface SaveRow {
  save_id: string;
  scenario_id: string;
  dynasty_id: string;
  title: string;
  status: "active" | "archived" | "deleted";
  head_revision: number;
  schema_version: number;
  state_version: number;
  lineage_id: string;
  parent_save_id: string | null;
  source_metadata_mode: "full" | "omit_catalog";
  created_at: string;
  updated_at: string;
  last_played_at: string | null;
  metadata_json: string;
}

interface SnapshotRow {
  snapshot_id: string;
  save_id: string;
  revision: number;
  checkpoint_kind: CheckpointMetadata["kind"];
  label: string | null;
  state_json: string;
  state_hash: string;
  created_at: string;
}

interface ChangeRow {
  log_id: string;
  save_id: string;
  revision: number;
  tx_id: string;
  sequence: number;
  timestamp: string;
  actor_type: StateChangeLogEntry["actorType"];
  actor_id: string;
  command_type: string;
  command_id: string;
  aggregate_type: string;
  entity_id: string | null;
  operation: StateChangeLogEntry["operation"];
  path: string;
  diff_json: string;
  inverse_diff_json: string | null;
  source_ids_json: string;
  tags_json: string;
  visibility: StateChangeLogEntry["visibility"];
  before_hash: string | null;
  after_hash: string;
  prev_log_hash: string | null;
  entry_hash: string;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function changesCount(result: StatementResultingChanges): number {
  return Number(result.changes);
}

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function saveMetadataFromRow(
  row: SaveRow,
  currentDate: string,
  snapshotCount: number,
): SaveMetadata {
  return SaveMetadataSchema.parse({
    saveId: row.save_id,
    scenarioId: row.scenario_id,
    dynastyId: row.dynasty_id,
    title: row.title,
    status: row.status,
    headRevision: Number(row.head_revision),
    schemaVersion: Number(row.schema_version),
    stateVersion: Number(row.state_version),
    lineageId: row.lineage_id,
    parentSaveId: row.parent_save_id,
    sourceMetadataMode: row.source_metadata_mode,
    currentDate,
    snapshotCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastPlayedAt: row.last_played_at,
  });
}

function logEntryFromRow(row: ChangeRow): StateChangeLogEntry {
  const diff = json<{ before: unknown; after: unknown; reason?: string }>(row.diff_json);
  return StateChangeLogEntrySchema.parse({
    logId: row.log_id,
    saveId: row.save_id,
    revision: Number(row.revision),
    txId: row.tx_id,
    sequence: Number(row.sequence),
    timestamp: row.timestamp,
    actorType: row.actor_type,
    actorId: row.actor_id,
    commandType: row.command_type,
    commandId: row.command_id,
    aggregateType: row.aggregate_type,
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    operation: row.operation,
    path: row.path,
    before: diff.before,
    after: diff.after,
    ...(row.inverse_diff_json ? { inverse: json(row.inverse_diff_json) } : {}),
    ...(diff.reason ? { reason: diff.reason } : {}),
    sourceIds: json(row.source_ids_json),
    tags: json(row.tags_json),
    visibility: row.visibility,
    ...(row.before_hash ? { beforeHash: row.before_hash } : {}),
    afterHash: row.after_hash,
    prevLogHash: row.prev_log_hash,
    entryHash: row.entry_hash,
  });
}

export class SqliteSaveRepository implements SaveRepositoryContract {
  constructor(
    readonly database: DatabaseSync,
    private readonly clock: Clock,
    private readonly options: RepositoryOptions,
  ) {}

  private requireSaveRow(saveId: string): SaveRow {
    const row = this.database.prepare("SELECT * FROM saves WHERE save_id = ?").get(saveId) as
      SaveRow | undefined;
    if (!row || row.status === "deleted") {
      throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
    }
    return row;
  }

  private snapshotCount(saveId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM save_snapshots WHERE save_id = ?")
      .get(saveId) as { count: number };
    return Number(row.count);
  }

  createSave(input: CreateSaveRecordInput): SaveMetadata {
    if (this.database.prepare("SELECT 1 FROM saves WHERE save_id = ?").get(input.metadata.saveId)) {
      throw new SaveSystemError("SAVE_ALREADY_EXISTS", `存档已存在：${input.metadata.saveId}`);
    }
    const state = GameStateSchema.parse(input.state);
    const metadata = SaveMetadataSchema.parse(input.metadata);
    const stateHash = hashState(state);
    const ownsTransaction = !this.database.isTransaction;
    try {
      if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          `INSERT INTO saves (
            save_id, scenario_id, dynasty_id, title, status, head_revision,
            schema_version, state_version, lineage_id, parent_save_id,
            source_metadata_mode, created_at, updated_at, last_played_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          metadata.saveId,
          metadata.scenarioId,
          metadata.dynastyId,
          metadata.title,
          metadata.status,
          metadata.headRevision,
          metadata.schemaVersion,
          metadata.stateVersion,
          metadata.lineageId,
          metadata.parentSaveId,
          metadata.sourceMetadataMode,
          metadata.createdAt,
          metadata.updatedAt,
          metadata.lastPlayedAt,
          stableStringify({
            headStateHash: stateHash,
            sourceCatalog: input.sourceCatalog ?? [],
          }),
        );
      this.insertSnapshot(state, "initial", null, metadata.createdAt);
      if (ownsTransaction) this.database.exec("COMMIT");
      return this.getSave(metadata.saveId) as SaveMetadata;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listSaves(options: { includeArchived?: boolean } = {}): SaveMetadata[] {
    const rows = this.database
      .prepare(
        options.includeArchived
          ? "SELECT * FROM saves WHERE status <> 'deleted' ORDER BY updated_at DESC, save_id"
          : "SELECT * FROM saves WHERE status = 'active' ORDER BY updated_at DESC, save_id",
      )
      .all() as unknown as SaveRow[];
    return rows.map((row) => {
      const state = this.loadStateAtRevision(row.save_id, Number(row.head_revision));
      return saveMetadataFromRow(row, state.currentDate, this.snapshotCount(row.save_id));
    });
  }

  getSave(saveId: string): SaveMetadata | null {
    const row = this.database.prepare("SELECT * FROM saves WHERE save_id = ?").get(saveId) as
      SaveRow | undefined;
    if (!row || row.status === "deleted") return null;
    const state = this.loadStateAtRevision(saveId, Number(row.head_revision));
    return saveMetadataFromRow(row, state.currentDate, this.snapshotCount(saveId));
  }

  archiveSave(saveId: string): void {
    const now = this.clock.now().toISOString();
    const result = this.database
      .prepare(
        "UPDATE saves SET status = 'archived', updated_at = ? WHERE save_id = ? AND status <> 'deleted'",
      )
      .run(now, saveId);
    if (changesCount(result) !== 1)
      throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
  }

  loadHeadState(saveId: string): GameState {
    const save = this.requireSaveRow(saveId);
    return this.loadStateAtRevision(saveId, Number(save.head_revision));
  }

  loadStateAtRevision(saveId: string, revision: number): GameState {
    const save = this.requireSaveRow(saveId);
    if (revision < 0 || revision > Number(save.head_revision)) {
      throw new SaveSystemError("STATE_INVALID", `revision 超出范围：${revision}`);
    }
    const snapshot = this.database
      .prepare(
        "SELECT * FROM save_snapshots WHERE save_id = ? AND revision <= ? AND checkpoint_kind <> 'pre_migration' ORDER BY revision DESC LIMIT 1",
      )
      .get(saveId, revision) as SnapshotRow | undefined;
    if (!snapshot) throw new SaveSystemError("STATE_INVALID", `存档缺少可用快照：${saveId}`);
    let state = GameStateSchema.parse(json(snapshot.state_json));
    if (hashState(state) !== snapshot.state_hash) {
      throw new SaveSystemError("STATE_INVALID", `快照哈希不匹配：${snapshot.snapshot_id}`);
    }
    const changes = this.loadChanges(saveId, Number(snapshot.revision) + 1, revision);
    if (changes.length > 0) {
      const mutations: ProposedMutation[] = changes.map((entry) => ({
        aggregateType: entry.aggregateType,
        ...(entry.entityId ? { entityId: entry.entityId } : {}),
        operation: entry.operation,
        path: entry.path,
        before: entry.before,
        after: entry.after,
        ...(entry.reason ? { reason: entry.reason } : {}),
        sourceIds: entry.sourceIds,
        visibility: entry.visibility,
        tags: entry.tags,
      }));
      state = GameStateSchema.parse(applyMutations(state, mutations));
    }
    if (state.revision !== revision) {
      throw new SaveSystemError(
        "STATE_INVALID",
        `重放 revision 不一致：期望 ${revision}，得到 ${state.revision}`,
      );
    }
    if (revision === Number(save.head_revision)) {
      const metadata = json<{ headStateHash?: string }>(save.metadata_json);
      if (metadata.headStateHash && metadata.headStateHash !== hashState(state)) {
        throw new SaveSystemError("STATE_INVALID", "存档 head state hash 不匹配");
      }
    }
    return state;
  }

  loadChanges(
    saveId: string,
    fromRevisionOrQuery: number | ChangeQuery = 0,
    toRevision?: number,
  ): StateChangeLogEntry[] {
    const query: ChangeQuery =
      typeof fromRevisionOrQuery === "number"
        ? { fromRevision: fromRevisionOrQuery, ...(toRevision === undefined ? {} : { toRevision }) }
        : fromRevisionOrQuery;
    const clauses = ["save_id = ?", "revision >= ?", "revision <= ?"];
    const values: Array<string | number> = [
      saveId,
      query.fromRevision ?? 0,
      query.toRevision ?? Number.MAX_SAFE_INTEGER,
    ];
    const filters = [
      ["command_type", query.commandType],
      ["actor_type", query.actorType],
      ["aggregate_type", query.aggregateType],
      ["entity_id", query.entityId],
      ["visibility", query.visibility],
    ] as const;
    for (const [column, value] of filters) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        values.push(value);
      }
    }
    const limit = Math.min(Math.max(query.limit ?? 10_000, 1), 10_000);
    const cursor = Math.max(query.cursor ?? 0, 0);
    values.push(limit, cursor);
    const rows = this.database
      .prepare(
        `SELECT * FROM state_change_log WHERE ${clauses.join(
          " AND ",
        )} ORDER BY revision, sequence LIMIT ? OFFSET ?`,
      )
      .all(...values) as unknown as ChangeRow[];
    return rows.map(logEntryFromRow);
  }

  listCheckpoints(saveId: string): CheckpointMetadata[] {
    this.requireSaveRow(saveId);
    const rows = this.database
      .prepare("SELECT * FROM save_snapshots WHERE save_id = ? ORDER BY revision")
      .all(saveId) as unknown as SnapshotRow[];
    return rows.map((row) =>
      CheckpointMetadataSchema.parse({
        snapshotId: row.snapshot_id,
        saveId: row.save_id,
        revision: Number(row.revision),
        kind: row.checkpoint_kind,
        label: row.label,
        stateHash: row.state_hash,
        createdAt: row.created_at,
      }),
    );
  }

  private insertSnapshot(
    state: GameState,
    kind: CheckpointMetadata["kind"],
    label: string | null,
    createdAt: string,
  ): CheckpointMetadata {
    const snapshotId = id("snapshot");
    const stateHash = hashState(state);
    this.database
      .prepare(
        "INSERT INTO save_snapshots (snapshot_id, save_id, revision, checkpoint_kind, label, state_json, state_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        snapshotId,
        state.saveId,
        state.revision,
        kind,
        label,
        stableStringify(state),
        stateHash,
        createdAt,
      );
    return CheckpointMetadataSchema.parse({
      snapshotId,
      saveId: state.saveId,
      revision: state.revision,
      kind,
      label,
      stateHash,
      createdAt,
    });
  }

  createCheckpoint(saveId: string, input: CheckpointInput): CheckpointMetadata {
    const state = this.loadHeadState(saveId);
    const existing = this.database
      .prepare(
        "SELECT * FROM save_snapshots WHERE save_id = ? AND revision = ? AND checkpoint_kind <> 'pre_migration'",
      )
      .get(saveId, state.revision) as SnapshotRow | undefined;
    if (existing) {
      return CheckpointMetadataSchema.parse({
        snapshotId: existing.snapshot_id,
        saveId: existing.save_id,
        revision: Number(existing.revision),
        kind: existing.checkpoint_kind,
        label: existing.label,
        stateHash: existing.state_hash,
        createdAt: existing.created_at,
      });
    }
    const now = this.clock.now().toISOString();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const checkpoint = this.insertSnapshot(state, input.kind, input.label ?? null, now);
      this.database.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw new SaveSystemError("CHECKPOINT_FAILED", "创建 checkpoint 失败", error);
    }
  }

  findIdempotentResult(saveId: string, idempotencyKey: string): CommitResult | null {
    const row = this.database
      .prepare(
        "SELECT summary_json FROM command_transactions WHERE save_id = ? AND idempotency_key = ? AND status = 'committed'",
      )
      .get(saveId, idempotencyKey) as { summary_json: string } | undefined;
    return row ? json<CommitResult>(row.summary_json) : null;
  }

  private lastLogHash(saveId: string): string | null {
    const row = this.database
      .prepare(
        "SELECT entry_hash FROM state_change_log WHERE save_id = ? ORDER BY revision DESC, sequence DESC LIMIT 1",
      )
      .get(saveId) as { entry_hash: string } | undefined;
    return row?.entry_hash ?? null;
  }

  private appendLogs(
    command: GameCommand,
    transition: StateTransition,
    txId: string,
    timestamp: string,
  ): StateChangeLogEntry[] {
    let previousHash = this.lastLogHash(command.saveId);
    const entries: StateChangeLogEntry[] = [];
    const insert = this.database.prepare(
      `INSERT INTO state_change_log (
        log_id, save_id, revision, tx_id, sequence, timestamp, actor_type, actor_id,
        command_type, command_id, aggregate_type, entity_id, operation, path,
        diff_json, inverse_diff_json, source_ids_json, tags_json, visibility,
        before_hash, after_hash, prev_log_hash, entry_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transition.mutations.forEach((item, sequence) => {
      const withoutEntryHash = {
        logId: id("log"),
        saveId: command.saveId,
        revision: transition.nextState.revision,
        txId,
        sequence,
        timestamp,
        actorType: command.actor.type,
        actorId: command.actor.id,
        commandType: command.commandType,
        commandId: command.commandId,
        aggregateType: item.aggregateType,
        ...(item.entityId ? { entityId: item.entityId } : {}),
        operation: item.operation,
        path: item.path,
        before: item.before,
        after: item.after,
        inverse: {
          operation: invertMutation(item).operation,
          path: item.path,
          value: item.before,
        },
        ...(item.reason ? { reason: item.reason } : {}),
        sourceIds: item.sourceIds,
        tags: item.tags ?? [],
        visibility: item.visibility,
        ...(sequence === 0 ? { beforeHash: transition.beforeHash } : {}),
        afterHash: transition.afterHash,
        prevLogHash: previousHash,
      };
      const entry = StateChangeLogEntrySchema.parse({
        ...withoutEntryHash,
        entryHash: sha256Hex(stableStringify(withoutEntryHash)),
      });
      insert.run(
        entry.logId,
        entry.saveId,
        entry.revision,
        entry.txId,
        entry.sequence,
        entry.timestamp,
        entry.actorType,
        entry.actorId,
        entry.commandType,
        entry.commandId,
        entry.aggregateType,
        entry.entityId ?? null,
        entry.operation,
        entry.path,
        stableStringify({ before: entry.before, after: entry.after, reason: entry.reason }),
        stableStringify(entry.inverse),
        stableStringify(entry.sourceIds),
        stableStringify(entry.tags),
        entry.visibility,
        entry.beforeHash ?? null,
        entry.afterHash,
        entry.prevLogHash,
        entry.entryHash,
        timestamp,
      );
      entries.push(entry);
      previousHash = entry.entryHash;
    });
    return entries;
  }

  commitTransition(
    command: GameCommand,
    transition: StateTransition,
    options: CommitTransitionOptions = {},
  ): CommitResult {
    const txId = id("tx");
    const now = this.clock.now().toISOString();
    const result: CommitResult = {
      txId,
      revision: transition.nextState.revision,
      stateHash: transition.afterHash,
      mutationCount: transition.mutations.length,
      idempotent: false,
    };
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database.exec("SAVEPOINT validate");
      const save = this.requireSaveRow(command.saveId);
      if (Number(save.head_revision) !== command.baseRevision) {
        throw new SaveSystemError(
          "STATE_REVISION_CONFLICT",
          `revision 冲突：期望 ${save.head_revision}，收到 ${command.baseRevision}`,
        );
      }
      if (save.status !== "active") {
        throw new SaveSystemError("SAVE_ARCHIVED", `存档不可写：${command.saveId}`);
      }
      this.database.exec("RELEASE validate");

      this.database.exec("SAVEPOINT apply");
      if (options.preCommitCheckpoint) {
        const existingCheckpoint = this.database
          .prepare(
            "SELECT 1 FROM save_snapshots WHERE save_id = ? AND revision = ? AND checkpoint_kind <> 'pre_migration'",
          )
          .get(command.saveId, command.baseRevision);
        if (!existingCheckpoint) {
          const currentState = this.loadStateAtRevision(command.saveId, command.baseRevision);
          this.insertSnapshot(
            currentState,
            options.preCommitCheckpoint.kind,
            options.preCommitCheckpoint.label ?? null,
            now,
          );
        }
      }
      this.database
        .prepare(
          `INSERT INTO command_transactions (
            tx_id, save_id, base_revision, target_revision, command_type, command_id,
            actor_type, actor_id, status, idempotency_key, summary_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', ?)`,
        )
        .run(
          txId,
          command.saveId,
          command.baseRevision,
          transition.nextState.revision,
          command.commandType,
          command.commandId,
          command.actor.type,
          command.actor.id,
          command.idempotencyKey ?? null,
          now,
        );
      this.options.failureInjector?.("after_transaction");
      this.appendLogs(command, transition, txId, now);
      this.options.failureInjector?.("after_logs");
      const update = this.database
        .prepare(
          `UPDATE saves SET head_revision = ?, state_version = ?, updated_at = ?,
             last_played_at = ?, metadata_json = ?
           WHERE save_id = ? AND head_revision = ?`,
        )
        .run(
          transition.nextState.revision,
          transition.nextState.stateVersion,
          now,
          now,
          stableStringify({
            ...json<Record<string, unknown>>(save.metadata_json),
            headStateHash: transition.afterHash,
          }),
          command.saveId,
          command.baseRevision,
        );
      if (changesCount(update) !== 1) {
        throw new SaveSystemError("STATE_REVISION_CONFLICT", "更新 save head 时发生 revision 冲突");
      }
      this.options.failureInjector?.("after_head");
      if (transition.nextState.revision % this.options.checkpointInterval === 0) {
        this.insertSnapshot(transition.nextState, "periodic", null, now);
      }
      this.options.failureInjector?.("after_checkpoint");
      this.database.exec("RELEASE apply");

      this.database.exec("SAVEPOINT finalize");
      this.database
        .prepare(
          "UPDATE command_transactions SET status = 'committed', summary_json = ?, committed_at = ? WHERE tx_id = ?",
        )
        .run(stableStringify(result), now, txId);
      options.validateBeforeCommit?.();
      this.database.exec("RELEASE finalize");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  countRows(): RowCounts {
    const count = (table: string) =>
      Number(
        (
          this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      );
    return {
      saves: count("saves"),
      transactions: count("command_transactions"),
      snapshots: count("save_snapshots"),
      logs: count("state_change_log"),
    };
  }
}
