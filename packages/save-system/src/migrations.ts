import { sha256Hex } from "@mandate/game-engine";
import type { DatabaseSync } from "node:sqlite";
import { SaveSystemError } from "./errors";

export interface DatabaseMigration {
  id: string;
  appVersion: string;
  fromVersion: number;
  toVersion: number;
  sql: string;
}

const INITIAL_SCHEMA = `
CREATE TABLE saves (
  save_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  dynasty_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
  head_revision INTEGER NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  lineage_id TEXT NOT NULL,
  parent_save_id TEXT,
  source_metadata_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (source_metadata_mode IN ('full', 'omit_catalog')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_played_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE TABLE command_transactions (
  tx_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  command_type TEXT NOT NULL,
  command_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'rolled_back', 'failed')),
  idempotency_key TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT,
  error_message TEXT,
  UNIQUE(save_id, command_id)
) STRICT;

CREATE TABLE save_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  checkpoint_kind TEXT NOT NULL
    CHECK (checkpoint_kind IN ('initial', 'periodic', 'manual', 'pre_migration', 'pre_import')),
  label TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(save_id, revision, checkpoint_kind)
) STRICT;

CREATE TABLE state_change_log (
  log_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  tx_id TEXT NOT NULL REFERENCES command_transactions(tx_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  timestamp TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  entity_id TEXT,
  operation TEXT NOT NULL,
  path TEXT NOT NULL,
  diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
  inverse_diff_json TEXT CHECK (inverse_diff_json IS NULL OR json_valid(inverse_diff_json)),
  source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('public', 'internal', 'sealed')),
  before_hash TEXT,
  after_hash TEXT NOT NULL CHECK (length(after_hash) = 64),
  prev_log_hash TEXT,
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(save_id, revision, sequence),
  UNIQUE(save_id, tx_id, sequence)
) STRICT;

CREATE TABLE schema_migrations (
  migration_id TEXT PRIMARY KEY,
  app_version TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_history (
  import_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  package_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_from_client_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('noop', 'fast_forward', 'forked', 'rejected', 'failed'))
) STRICT;

CREATE TABLE save_state_migrations (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  migration_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version > from_version),
  backup_snapshot_id TEXT NOT NULL REFERENCES save_snapshots(snapshot_id) ON DELETE CASCADE,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (save_id, migration_id)
) STRICT;

CREATE INDEX idx_state_change_log_save_revision
  ON state_change_log(save_id, revision);
CREATE INDEX idx_state_change_log_entity
  ON state_change_log(save_id, aggregate_type, entity_id);
CREATE INDEX idx_command_transactions_save_status
  ON command_transactions(save_id, status);
CREATE UNIQUE INDEX idx_command_transactions_idempotency
  ON command_transactions(save_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_save_snapshots_save_revision
  ON save_snapshots(save_id, revision DESC);
CREATE INDEX idx_import_history_package
  ON import_history(save_id, package_hash);

PRAGMA user_version = 1;
`;

/**
 * Phase 3：人物记忆与对话记录（ADR-012）。
 * 两张表都不属于 GameState：写入不产生 StateChangeLog，不影响 revision 与状态 Hash。
 */
const CHARACTER_MEMORY_SCHEMA = `
CREATE TABLE character_memories (
  memory_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'episodic', 'semantic', 'relationship', 'belief',
    'commitment', 'suspicion', 'instruction', 'summary')),
  content TEXT NOT NULL,
  structured_content_json TEXT
    CHECK (structured_content_json IS NULL OR json_valid(structured_content_json)),
  related_character_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(related_character_ids_json)),
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(related_entity_ids_json)),
  topic_tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(topic_tags_json)),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  source_tx_id TEXT,
  source_meeting_id TEXT,
  source_command_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'observed', 'told', 'official-record', 'rumor', 'inference', 'agent-generated-summary')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
  visibility TEXT NOT NULL CHECK (visibility IN ('self', 'private', 'shareable', 'sealed')),
  status TEXT NOT NULL CHECK (status IN ('active', 'outdated', 'contradicted', 'forgotten')),
  created_at TEXT NOT NULL,
  last_recalled_at TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0)
) STRICT;

CREATE TABLE character_conversation_turns (
  turn_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN (
    'private-audience', 'court-assembly', 'imperial-council',
    'secret-council', 'memorial-response', 'general')),
  input_text TEXT NOT NULL,
  speech TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  prompt_versions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(prompt_versions_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_character_memories_character
  ON character_memories(save_id, character_id, status);
CREATE INDEX idx_character_memories_revision
  ON character_memories(save_id, character_id, source_revision);
CREATE INDEX idx_character_turns_character
  ON character_conversation_turns(save_id, character_id, created_at);

PRAGMA user_version = 2;
`;

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    id: "001-initial-save-schema",
    appVersion: "0.2.0",
    fromVersion: 0,
    toVersion: 1,
    sql: INITIAL_SCHEMA,
  },
  {
    id: "002-character-memories",
    appVersion: "0.3.0",
    fromVersion: 1,
    toVersion: 2,
    sql: CHARACTER_MEMORY_SCHEMA,
  },
];

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

export function applyDatabaseMigrations(database: DatabaseSync, now: string): void {
  let currentVersion = Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  for (const migration of DATABASE_MIGRATIONS) {
    const checksum = sha256Hex(migration.sql);
    if (tableExists(database, "schema_migrations")) {
      const existing = database
        .prepare("SELECT checksum, to_version FROM schema_migrations WHERE migration_id = ?")
        .get(migration.id) as { checksum: string; to_version: number } | undefined;
      if (existing) {
        if (existing.checksum !== checksum || Number(existing.to_version) !== migration.toVersion) {
          throw new SaveSystemError(
            "MIGRATION_FAILED",
            `数据库迁移校验和不匹配：${migration.id}`,
          );
        }
        currentVersion = Math.max(currentVersion, migration.toVersion);
        continue;
      }
    }
    if (currentVersion !== migration.fromVersion) continue;
    try {
      database.exec("BEGIN IMMEDIATE");
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (migration_id, app_version, from_version, to_version, checksum, applied_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          migration.id,
          migration.appVersion,
          migration.fromVersion,
          migration.toVersion,
          checksum,
          now,
        );
      database.exec("COMMIT");
      currentVersion = migration.toVersion;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw new SaveSystemError("MIGRATION_FAILED", `数据库迁移失败：${migration.id}`, error);
    }
  }
  const target = DATABASE_MIGRATIONS.at(-1)?.toVersion ?? 0;
  if (currentVersion !== target) {
    throw new SaveSystemError(
      "MIGRATION_FAILED",
      `数据库版本 ${currentVersion} 没有到 ${target} 的迁移路径`,
    );
  }
}
