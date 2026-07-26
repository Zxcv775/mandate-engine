import {
  GAME_STATE_SCHEMA_VERSION,
  GAME_STATE_VERSION,
  SaveImportResultSchema,
  SaveMetadataSchema,
  type GameState,
  type HistoricalSource,
  type SaveImportResult,
} from "@mandate/domain";
import { createScenarioLoader } from "@mandate/data-loader";
import { hashState, type Clock } from "@mandate/game-engine";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SaveSystemError } from "./errors";
import { DATABASE_MIGRATIONS } from "./migrations";
import type { ParsedSavePackage } from "./package-format";
import { SqliteSaveRepository } from "./repository";

interface SaveRow extends Record<string, SQLInputValue> {
  save_id: string;
  scenario_id: string;
  dynasty_id: string;
  title: string;
  status: string;
  head_revision: number;
  schema_version: number;
  state_version: number;
  lineage_id: string;
  parent_save_id: string | null;
  source_metadata_mode: string;
  created_at: string;
  updated_at: string;
  last_played_at: string | null;
  metadata_json: string;
}

interface TableDefinition {
  table: string;
  columns: readonly string[];
}

const SAVE_TABLE: TableDefinition = {
  table: "saves",
  columns: [
    "save_id",
    "scenario_id",
    "dynasty_id",
    "title",
    "status",
    "head_revision",
    "schema_version",
    "state_version",
    "lineage_id",
    "parent_save_id",
    "source_metadata_mode",
    "created_at",
    "updated_at",
    "last_played_at",
    "metadata_json",
  ],
};

const CHILD_TABLES: readonly TableDefinition[] = [
  {
    table: "command_transactions",
    columns: [
      "tx_id",
      "save_id",
      "base_revision",
      "target_revision",
      "command_type",
      "command_id",
      "actor_type",
      "actor_id",
      "status",
      "idempotency_key",
      "summary_json",
      "created_at",
      "committed_at",
      "rolled_back_at",
      "error_message",
    ],
  },
  {
    table: "save_snapshots",
    columns: [
      "snapshot_id",
      "save_id",
      "revision",
      "checkpoint_kind",
      "label",
      "state_json",
      "state_hash",
      "created_at",
    ],
  },
  {
    table: "state_change_log",
    columns: [
      "log_id",
      "save_id",
      "revision",
      "tx_id",
      "sequence",
      "timestamp",
      "actor_type",
      "actor_id",
      "command_type",
      "command_id",
      "aggregate_type",
      "entity_id",
      "operation",
      "path",
      "diff_json",
      "inverse_diff_json",
      "source_ids_json",
      "tags_json",
      "visibility",
      "before_hash",
      "after_hash",
      "prev_log_hash",
      "entry_hash",
      "created_at",
    ],
  },
  {
    table: "save_state_migrations",
    columns: [
      "save_id",
      "migration_id",
      "checksum",
      "from_version",
      "to_version",
      "backup_snapshot_id",
      "applied_at",
    ],
  },
];

/**
 * 人物记忆与对话记录随存档同行迁移（P4.0，ADR-012 补遗）。
 * 旧版载荷（数据库版本 1）没有这两张表——复制前须检查表存在。
 */
const MEMORY_TABLES: readonly TableDefinition[] = [
  {
    table: "character_memories",
    columns: [
      "memory_id",
      "save_id",
      "character_id",
      "type",
      "content",
      "structured_content_json",
      "related_character_ids_json",
      "related_entity_ids_json",
      "topic_tags_json",
      "source_revision",
      "source_tx_id",
      "source_meeting_id",
      "source_command_id",
      "source_type",
      "confidence",
      "importance",
      "visibility",
      "status",
      "created_at",
      "last_recalled_at",
      "recall_count",
    ],
  },
  {
    table: "character_conversation_turns",
    columns: [
      "turn_id",
      "save_id",
      "character_id",
      "speaker_id",
      "mode",
      "input_text",
      "speech",
      "state_revision",
      "prompt_versions_json",
      "created_at",
    ],
  },
];

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/**
 * Phase 4 会议表随存档迁移（ADR-018）。
 * 空库/快进导入按 save_id 复制；快进时会议 head 与可变子表用 REPLACE 取载荷较新态，
 * append-only 的 turns 用 IGNORE 去重。分叉导入不携带会议史（已知边界，见 docs/08）。
 */
const MEETING_IMPORT_TABLES: readonly { table: string; strategy: "replace" | "ignore" }[] = [
  { table: "meeting_sessions", strategy: "replace" },
  { table: "meeting_participants", strategy: "replace" },
  { table: "meeting_agenda_items", strategy: "replace" },
  { table: "meeting_turns", strategy: "ignore" },
  { table: "meeting_outcome_candidates", strategy: "replace" },
  { table: "meeting_minutes", strategy: "replace" },
  { table: "meeting_leak_assessments", strategy: "replace" },
];

function copyMeetingRows(source: DatabaseSync, target: DatabaseSync, saveId: string): void {
  for (const { table, strategy } of MEETING_IMPORT_TABLES) {
    if (!tableExists(source, table)) continue;
    const rows = source
      .prepare(
        table === "meeting_participants" || table === "meeting_agenda_items"
          ? `SELECT t.* FROM ${table} t
             JOIN meeting_sessions s ON s.meeting_id = t.meeting_id WHERE s.save_id = ?`
          : `SELECT * FROM ${table} WHERE save_id = ?`,
      )
      .all(saveId) as unknown as Array<Record<string, SQLInputValue>>;
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]!);
    const insert = target.prepare(
      `INSERT OR ${strategy === "replace" ? "REPLACE" : "IGNORE"} INTO ${table}
       (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      insert.run(...columns.map((column) => row[column] ?? null));
    }
  }
}

/** 载荷内记忆行的 revision 必须不超过其存档 head（§2.3 合法性校验） */
function assertMemoryRevisionsValid(
  database: DatabaseSync,
  saveId: string,
  headRevision: number,
): void {
  const checks: readonly (readonly [string, string])[] = [
    ["character_memories", "source_revision"],
    ["character_conversation_turns", "state_revision"],
  ];
  for (const [table, column] of checks) {
    if (!tableExists(database, table)) continue;
    const row = database
      .prepare(`SELECT COUNT(*) AS bad FROM ${table} WHERE save_id = ? AND ${column} > ?`)
      .get(saveId, headRevision) as { bad: number };
    if (Number(row.bad) > 0) {
      throw new SaveSystemError(
        "SAVE_PACKAGE_INVALID",
        `载荷 ${table} 存在超出 head revision 的记录`,
      );
    }
  }
}

/** 复制记忆行：主键去重合并（INSERT OR IGNORE），可选 saveId/主键重映射（fork 用） */
function copyMemoryRows(
  source: DatabaseSync,
  target: DatabaseSync,
  sourceSaveId: string,
  options: { targetSaveId?: string; rewritePrimaryKeyPrefix?: string } = {},
): void {
  for (const definition of MEMORY_TABLES) {
    if (!tableExists(source, definition.table)) continue;
    const primaryKey = definition.columns[0]!;
    const columns = definition.columns.join(", ");
    const rows = source
      .prepare(`SELECT ${columns} FROM ${definition.table} WHERE save_id = ?`)
      .all(sourceSaveId) as unknown as Array<Record<string, SQLInputValue>>;
    const insert = target.prepare(
      `INSERT OR IGNORE INTO ${definition.table} (${columns}) VALUES (${definition.columns
        .map(() => "?")
        .join(", ")})`,
    );
    for (const row of rows) {
      const copy: Record<string, SQLInputValue> = { ...row };
      if (options.targetSaveId) copy.save_id = options.targetSaveId;
      if (options.rewritePrimaryKeyPrefix) {
        copy[primaryKey] = `${options.rewritePrimaryKeyPrefix}${String(row[primaryKey])}`;
      }
      insert.run(...definition.columns.map((column) => copy[column] ?? null));
    }
  }
}

function importedSave(database: DatabaseSync, saveId: string): SaveRow {
  const row = database.prepare("SELECT * FROM saves WHERE save_id = ?").get(saveId) as
    SaveRow | undefined;
  if (!row) throw new SaveSystemError("SAVE_PACKAGE_INVALID", "payload 中找不到 manifest 存档");
  return row;
}

function insertRows(
  source: DatabaseSync,
  target: DatabaseSync,
  definition: TableDefinition,
  saveId: string,
  predicate: (row: Record<string, SQLInputValue>) => boolean = () => true,
): void {
  const columns = definition.columns.join(", ");
  const rows = source
    .prepare(`SELECT ${columns} FROM ${definition.table} WHERE save_id = ?`)
    .all(saveId) as unknown as Array<Record<string, SQLInputValue>>;
  const insert = target.prepare(
    `INSERT INTO ${definition.table} (${columns}) VALUES (${definition.columns
      .map(() => "?")
      .join(", ")})`,
  );
  for (const row of rows.filter(predicate)) {
    insert.run(...definition.columns.map((column) => row[column] ?? null));
  }
}

function recordImport(
  database: DatabaseSync,
  saveId: string,
  packageHash: string,
  importedAt: string,
  clientId: string | undefined,
  result: SaveImportResult["result"],
): void {
  database
    .prepare(
      "INSERT INTO import_history (import_id, save_id, package_hash, imported_at, imported_from_client_id, result) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(`import_${randomUUID()}`, saveId, packageHash, importedAt, clientId ?? null, result);
}

function storedSourceCatalog(row: SaveRow): HistoricalSource[] {
  const metadata = JSON.parse(row.metadata_json) as { sourceCatalog?: HistoricalSource[] };
  return metadata.sourceCatalog ?? [];
}

function result(value: Omit<SaveImportResult, "message"> & { message: string }): SaveImportResult {
  return SaveImportResultSchema.parse(value);
}

export interface ImportVerifiedPackageOptions {
  clientId?: string;
}

export async function importVerifiedPackage(
  local: SqliteSaveRepository,
  parsed: ParsedSavePackage,
  clock: Clock,
  options: ImportVerifiedPackageOptions = {},
): Promise<SaveImportResult> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-import-payload-"));
  const path = join(directory, "payload.sqlite");
  let importedDatabase: DatabaseSync | undefined;
  try {
    await writeFile(path, parsed.payload);
    try {
      importedDatabase = new DatabaseSync(path, { allowExtension: false });
      importedDatabase.exec("PRAGMA foreign_keys = ON");
      const integrity = importedDatabase.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      const foreignKeys = importedDatabase.prepare("PRAGMA foreign_key_check").all();
      if (!integrity.every((row) => row.integrity_check === "ok") || foreignKeys.length > 0) {
        throw new SaveSystemError("SAVE_PACKAGE_INVALID", "payload SQLite 完整性检查失败");
      }
    } catch (error) {
      if (error instanceof SaveSystemError) throw error;
      throw new SaveSystemError("SAVE_PACKAGE_INVALID", "payload SQLite 格式或完整性无效");
    }
    if (!importedDatabase) throw new SaveSystemError("SAVE_PACKAGE_INVALID", "payload SQLite 无效");
    const userVersion = Number(
      (importedDatabase.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    // 允许历史上任一已知数据库版本的载荷（旧版缺记忆表不影响存档行导入）
    const knownDatabaseVersions = new Set(
      DATABASE_MIGRATIONS.map((migration) => migration.toVersion),
    );
    if (
      !knownDatabaseVersions.has(userVersion) ||
      parsed.manifest.schemaVersion > GAME_STATE_SCHEMA_VERSION ||
      parsed.manifest.stateVersion > GAME_STATE_VERSION
    ) {
      throw new SaveSystemError("SAVE_VERSION_UNSUPPORTED", "存档版本没有可用迁移路径");
    }
    let importedRow = importedSave(importedDatabase, parsed.manifest.saveId);
    if (
      importedRow.scenario_id !== parsed.manifest.scenarioId ||
      importedRow.dynasty_id !== parsed.manifest.dynastyId ||
      Number(importedRow.head_revision) !== parsed.manifest.headRevision ||
      Number(importedRow.state_version) !== parsed.manifest.stateVersion ||
      importedRow.lineage_id !== parsed.manifest.lineageId ||
      importedRow.source_metadata_mode !== parsed.manifest.sourceMetadataMode
    ) {
      throw new SaveSystemError("SAVE_PACKAGE_INVALID", "manifest 与 payload 元数据不一致");
    }
    const importedRepository = new SqliteSaveRepository(importedDatabase, clock, {
      checkpointInterval: 50,
    });
    if (Number(importedRow.state_version) < GAME_STATE_VERSION) {
      const { GameStateService } = await import("./service");
      const migrationService = new GameStateService({
        repository: importedRepository,
        scenarioLoader: createScenarioLoader(),
        clock,
      });
      await migrationService.migrateSave(importedRow.save_id);
      importedRow = importedSave(importedDatabase, parsed.manifest.saveId);
    }
    const importedHead = importedRepository.loadHeadState(parsed.manifest.saveId);
    assertMemoryRevisionsValid(importedDatabase, parsed.manifest.saveId, importedHead.revision);
    const localSave = local.getSave(parsed.manifest.saveId);
    const importedAt = clock.now().toISOString();

    if (!localSave) {
      try {
        local.database.exec("BEGIN IMMEDIATE");
        insertRows(importedDatabase, local.database, SAVE_TABLE, parsed.manifest.saveId);
        for (const table of CHILD_TABLES) {
          insertRows(importedDatabase, local.database, table, parsed.manifest.saveId);
        }
        copyMemoryRows(importedDatabase, local.database, parsed.manifest.saveId);
        copyMeetingRows(importedDatabase, local.database, parsed.manifest.saveId);
        recordImport(
          local.database,
          parsed.manifest.saveId,
          parsed.packageHash,
          importedAt,
          options.clientId,
          "fast_forward",
        );
        local.database.exec("COMMIT");
      } catch (error) {
        if (local.database.isTransaction) local.database.exec("ROLLBACK");
        throw error;
      }
      return result({
        result: "fast_forward",
        saveId: parsed.manifest.saveId,
        headRevision: importedHead.revision,
        packageHash: parsed.packageHash,
        message: "存档已导入",
      });
    }

    const prior = local.database
      .prepare("SELECT result FROM import_history WHERE save_id = ? AND package_hash = ? LIMIT 1")
      .get(parsed.manifest.saveId, parsed.packageHash) as { result: string } | undefined;
    const localHead = local.loadHeadState(localSave.saveId);
    const sameRevision = localSave.headRevision === importedHead.revision;
    const derivedSharePackage =
      localSave.lineageId === importedRow.lineage_id &&
      (parsed.manifest.safeShareMode !== "none" ||
        parsed.manifest.sourceMetadataMode === "omit_catalog");
    if (
      prior ||
      (sameRevision && (hashState(localHead) === hashState(importedHead) || derivedSharePackage))
    ) {
      if (!prior) {
        recordImport(
          local.database,
          localSave.saveId,
          parsed.packageHash,
          importedAt,
          options.clientId,
          "noop",
        );
      }
      return result({
        result: "noop",
        saveId: localSave.saveId,
        headRevision: localSave.headRevision,
        packageHash: parsed.packageHash,
        message: "相同存档包已存在",
      });
    }

    let ancestor = false;
    if (
      localSave.lineageId === importedRow.lineage_id &&
      importedHead.revision > localHead.revision
    ) {
      try {
        ancestor =
          hashState(
            importedRepository.loadStateAtRevision(importedRow.save_id, localHead.revision),
          ) === hashState(localHead);
      } catch {
        ancestor = false;
      }
    }
    if (ancestor) {
      try {
        local.database.exec("BEGIN IMMEDIATE");
        for (const table of CHILD_TABLES) {
          insertRows(importedDatabase, local.database, table, importedRow.save_id, (row) => {
            if (table.table === "command_transactions") {
              return Number(row.target_revision) > localHead.revision;
            }
            return Number(row.revision) > localHead.revision;
          });
        }
        // 记忆行按主键去重合并（同世界线快进：本地已有行保持不变）
        copyMemoryRows(importedDatabase, local.database, importedRow.save_id);
        copyMeetingRows(importedDatabase, local.database, importedRow.save_id);
        local.database
          .prepare(
            `UPDATE saves SET title = ?, status = ?, head_revision = ?, schema_version = ?,
              state_version = ?, source_metadata_mode = ?, updated_at = ?, last_played_at = ?,
              metadata_json = ? WHERE save_id = ? AND head_revision = ?`,
          )
          .run(
            importedRow.title,
            importedRow.status,
            importedRow.head_revision,
            importedRow.schema_version,
            importedRow.state_version,
            importedRow.source_metadata_mode,
            importedRow.updated_at,
            importedRow.last_played_at,
            importedRow.metadata_json,
            importedRow.save_id,
            localHead.revision,
          );
        recordImport(
          local.database,
          importedRow.save_id,
          parsed.packageHash,
          importedAt,
          options.clientId,
          "fast_forward",
        );
        local.database.exec("COMMIT");
      } catch (error) {
        if (local.database.isTransaction) local.database.exec("ROLLBACK");
        throw error;
      }
      return result({
        result: "fast_forward",
        saveId: importedRow.save_id,
        headRevision: importedHead.revision,
        packageHash: parsed.packageHash,
        message: "同一世界线已快进",
      });
    }

    const forkSaveId = `save_${randomUUID()}`;
    const forkState: GameState = {
      ...structuredClone(importedHead),
      saveId: forkSaveId,
      meta: {
        ...structuredClone(importedHead.meta),
        forkedFromRevision: Math.min(localHead.revision, importedHead.revision),
        importedPackageHash: parsed.packageHash,
      },
    };
    const forkMetadata = SaveMetadataSchema.parse({
      saveId: forkSaveId,
      scenarioId: importedRow.scenario_id,
      dynastyId: importedRow.dynasty_id,
      title: `${importedRow.title}（导入分支）`,
      status: "active",
      headRevision: forkState.revision,
      schemaVersion: forkState.schemaVersion,
      stateVersion: forkState.stateVersion,
      lineageId: importedRow.lineage_id,
      parentSaveId: localSave.saveId,
      sourceMetadataMode: importedRow.source_metadata_mode,
      currentDate: forkState.currentDate,
      snapshotCount: 1,
      createdAt: importedAt,
      updatedAt: importedAt,
      lastPlayedAt: importedAt,
    });
    try {
      local.database.exec("BEGIN IMMEDIATE");
      local.createSave({
        metadata: forkMetadata,
        state: forkState,
        sourceCatalog: storedSourceCatalog(importedRow),
      });
      // fork：记忆行随世界线复制，saveId 重映射 + 主键前缀重写避免与本地行冲突
      copyMemoryRows(importedDatabase, local.database, importedRow.save_id, {
        targetSaveId: forkSaveId,
        rewritePrimaryKeyPrefix: `fork_${forkSaveId.slice(-12)}_`,
      });
      recordImport(
        local.database,
        forkSaveId,
        parsed.packageHash,
        importedAt,
        options.clientId,
        "forked",
      );
      local.database.exec("COMMIT");
    } catch (error) {
      if (local.database.isTransaction) local.database.exec("ROLLBACK");
      throw error;
    }
    return result({
      result: "forked",
      saveId: forkSaveId,
      originalSaveId: importedRow.save_id,
      headRevision: forkState.revision,
      packageHash: parsed.packageHash,
      message: "检测到分叉，已创建独立存档",
    });
  } catch (error) {
    if (error instanceof SaveSystemError) throw error;
    throw new SaveSystemError("SAVE_IMPORT_FAILED", "导入存档失败", error);
  } finally {
    importedDatabase?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
