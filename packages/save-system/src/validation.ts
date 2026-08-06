import {
  GameStateSchema,
  SaveValidationReportSchema,
  type SaveValidationReport,
} from "@mandate/domain";
import { hashState, sha256Hex, stableStringify } from "@mandate/game-engine";
import type { DatabaseSync } from "node:sqlite";
import { SaveSystemError } from "./errors";
import { DATABASE_MIGRATIONS } from "./migrations";
import { STATE_DOCUMENT_MIGRATIONS } from "./state-migrations";
import type { SqliteSaveRepository } from "./repository";

type ValidationStatus = "passed" | "warning" | "failed";
interface ValidationCheck {
  code: string;
  status: ValidationStatus;
  message: string;
  details?: unknown;
}

function check(
  code: string,
  status: ValidationStatus,
  message: string,
  details?: unknown,
): ValidationCheck {
  return { code, status, message, ...(details === undefined ? {} : { details }) };
}

interface SaveValidationRow {
  save_id: string;
  head_revision: number;
  state_version: number;
  metadata_json: string;
  source_metadata_mode: "full" | "omit_catalog";
}

export function validateSave(
  database: DatabaseSync,
  repository: SqliteSaveRepository,
  saveId: string,
): SaveValidationReport {
  const save = database
    .prepare(
      "SELECT save_id, head_revision, state_version, metadata_json, source_metadata_mode FROM saves WHERE save_id = ? AND status <> 'deleted'",
    )
    .get(saveId) as SaveValidationRow | undefined;
  if (!save) throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);

  const checks: ValidationCheck[] = [];
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  const integrityPassed = integrity.every((row) => row.integrity_check === "ok");
  checks.push(
    check(
      "SQLITE_INTEGRITY",
      integrityPassed ? "passed" : "failed",
      integrityPassed ? "SQLite integrity_check 通过" : "SQLite 文件损坏",
      integrity,
    ),
  );

  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  checks.push(
    check(
      "FOREIGN_KEYS",
      foreignKeys.length === 0 ? "passed" : "failed",
      foreignKeys.length === 0 ? "外键检查通过" : "存在外键违规",
      foreignKeys,
    ),
  );

  const appliedMigrations = database
    .prepare("SELECT migration_id, checksum FROM schema_migrations ORDER BY migration_id")
    .all() as Array<{ migration_id: string; checksum: string }>;
  const migrationFailures = DATABASE_MIGRATIONS.filter((migration) => {
    const applied = appliedMigrations.find((row) => row.migration_id === migration.id);
    return !applied || applied.checksum !== sha256Hex(migration.sql);
  }).map((migration) => migration.id);
  checks.push(
    check(
      "MIGRATIONS",
      migrationFailures.length === 0 ? "passed" : "failed",
      migrationFailures.length === 0 ? "数据库迁移记录完整" : "数据库迁移记录缺失或被修改",
      migrationFailures,
    ),
  );

  const stateMigrationRows = database
    .prepare(
      "SELECT migration_id, checksum, from_version, to_version FROM save_state_migrations WHERE save_id = ? ORDER BY migration_id",
    )
    .all(saveId) as Array<{
    migration_id: string;
    checksum: string;
    from_version: number;
    to_version: number;
  }>;
  const stateMigrationFailures = stateMigrationRows
    .filter((row) => {
      const migration = STATE_DOCUMENT_MIGRATIONS.find((item) => item.id === row.migration_id);
      return (
        !migration ||
        migration.checksum !== row.checksum ||
        migration.fromVersion !== Number(row.from_version) ||
        migration.toVersion !== Number(row.to_version) ||
        Number(row.to_version) > Number(save.state_version)
      );
    })
    .map((row) => row.migration_id);
  checks.push(
    check(
      "STATE_MIGRATIONS",
      stateMigrationFailures.length === 0 ? "passed" : "failed",
      stateMigrationFailures.length === 0
        ? "存档状态迁移记录与 checksum 通过"
        : "存档状态迁移记录缺失定义或 checksum 不匹配",
      stateMigrationFailures,
    ),
  );

  const transactionRows = database
    .prepare(
      "SELECT tx_id, base_revision, target_revision, status FROM command_transactions WHERE save_id = ? ORDER BY target_revision",
    )
    .all(saveId) as Array<{
    tx_id: string;
    base_revision: number;
    target_revision: number;
    status: string;
  }>;
  const rawLogRows = database
    .prepare(
      "SELECT tx_id, revision, sequence FROM state_change_log WHERE save_id = ? ORDER BY revision, sequence",
    )
    .all(saveId) as Array<{ tx_id: string; revision: number; sequence: number }>;
  const transactionIssues: string[] = [];
  for (const transaction of transactionRows) {
    const logs = rawLogRows.filter((row) => row.tx_id === transaction.tx_id);
    if (transaction.status === "committed") {
      if (Number(transaction.target_revision) !== Number(transaction.base_revision) + 1) {
        transactionIssues.push(`${transaction.tx_id}:target_revision`);
      }
      if (logs.length === 0) transactionIssues.push(`${transaction.tx_id}:missing_logs`);
      if (logs.some((row) => Number(row.revision) !== Number(transaction.target_revision))) {
        transactionIssues.push(`${transaction.tx_id}:log_revision`);
      }
    } else if (logs.length > 0) {
      transactionIssues.push(`${transaction.tx_id}:non_committed_logs`);
    }
  }
  checks.push(
    check(
      "TRANSACTION_CONSISTENCY",
      transactionIssues.length === 0 ? "passed" : "failed",
      transactionIssues.length === 0
        ? "命令事务状态与日志自洽"
        : "命令事务缺少日志、revision 不匹配或非 committed 事务带日志",
      transactionIssues,
    ),
  );

  const sequenceIssues: string[] = [];
  const logTxIds = [...new Set(rawLogRows.map((row) => row.tx_id))];
  for (const txId of logTxIds) {
    const sequences = rawLogRows
      .filter((row) => row.tx_id === txId)
      .map((row) => Number(row.sequence))
      .sort((left, right) => left - right);
    if (sequences.some((sequence, index) => sequence !== index)) {
      sequenceIssues.push(txId);
    }
  }
  checks.push(
    check(
      "LOG_SEQUENCE",
      sequenceIssues.length === 0 ? "passed" : "failed",
      sequenceIssues.length === 0 ? "事务内日志 sequence 连续" : "事务内日志 sequence 存在缺口",
      sequenceIssues,
    ),
  );
  const snapshotRevisionRows = database
    .prepare("SELECT revision FROM save_snapshots WHERE save_id = ? ORDER BY revision")
    .all(saveId) as Array<{ revision: number }>;
  const headRevision = Number(save.head_revision);
  const hasHeadSnapshot = snapshotRevisionRows.some((row) => Number(row.revision) === headRevision);
  const anchorRevision = Math.min(
    headRevision,
    ...snapshotRevisionRows.map((row) => Number(row.revision)),
  );
  const committedRevisions = new Set(
    transactionRows
      .filter((row) => row.status === "committed")
      .map((row) => Number(row.target_revision)),
  );
  const missingRevisions = hasHeadSnapshot
    ? []
    : Array.from(
        { length: Math.max(0, headRevision - anchorRevision) },
        (_, index) => anchorRevision + index + 1,
      ).filter((revision) => !committedRevisions.has(revision));
  checks.push(
    check(
      "REVISION_CONTINUITY",
      missingRevisions.length === 0 ? "passed" : "failed",
      missingRevisions.length === 0
        ? "revision 连续或由 head snapshot 完整锚定"
        : "revision 存在缺口",
      missingRevisions,
    ),
  );

  const snapshotRows = database
    .prepare(
      "SELECT snapshot_id, revision, state_json, state_hash FROM save_snapshots WHERE save_id = ?",
    )
    .all(saveId) as Array<{
    snapshot_id: string;
    revision: number;
    state_json: string;
    state_hash: string;
  }>;
  const badSnapshots = snapshotRows
    .filter((row) => {
      try {
        return (
          Number(row.revision) > headRevision ||
          hashState(JSON.parse(row.state_json)) !== row.state_hash
        );
      } catch {
        return true;
      }
    })
    .map((row) => row.snapshot_id);
  checks.push(
    check(
      "SNAPSHOT_HASH",
      badSnapshots.length === 0 ? "passed" : "failed",
      badSnapshots.length === 0 ? "快照哈希与 revision 通过" : "存在无效快照",
      badSnapshots,
    ),
  );

  let entries: ReturnType<SqliteSaveRepository["loadChanges"]> = [];
  const badLogs: string[] = [];
  try {
    entries = repository.loadChanges(saveId, 0);
    let previous: string | null = null;
    for (const entry of entries) {
      const { entryHash, ...withoutHash } = entry;
      if (entry.prevLogHash !== previous || sha256Hex(stableStringify(withoutHash)) !== entryHash) {
        badLogs.push(entry.logId);
      }
      previous = entryHash;
    }
  } catch (error) {
    badLogs.push(`parse:${String(error)}`);
  }
  checks.push(
    check(
      "LOG_HASH_CHAIN",
      badLogs.length === 0 ? "passed" : "failed",
      badLogs.length === 0 ? "StateChangeLog 哈希链通过" : "StateChangeLog 哈希链断裂",
      badLogs,
    ),
  );

  let headState: unknown;
  try {
    headState = repository.loadHeadState(saveId);
    checks.push(check("HEAD_REPLAY", "passed", "snapshot + log 可重放至 head"));
  } catch (error) {
    checks.push(check("HEAD_REPLAY", "failed", "head 重放失败", String(error)));
  }

  const headStateResult = GameStateSchema.safeParse(headState);
  checks.push(
    check(
      "GAME_STATE_SCHEMA",
      headStateResult.success ? "passed" : "failed",
      headStateResult.success ? "head GameState Schema 通过" : "head GameState Schema 无效",
      headStateResult.success ? [] : headStateResult.error.issues,
    ),
  );

  const sourceIssues: string[] = [];
  const rngIssues: string[] = [];
  if (headState !== undefined) {
    const parsed = headStateResult;
    if (!parsed.success) {
      sourceIssues.push("GameState Schema 无效");
      rngIssues.push("GameState Schema 无效");
    } else {
      if (parsed.data.meta.sourceIds.length === 0 || parsed.data.country.sourceIds.length === 0) {
        sourceIssues.push("顶层或国家 sourceIds 为空");
      }
      for (const character of Object.values(parsed.data.characters)) {
        if (character.sourceIds.length === 0)
          sourceIssues.push(`人物 ${character.characterId} sourceIds 为空`);
      }
      if (
        !Number.isInteger(parsed.data.rng.cursor) ||
        parsed.data.rng.cursor < 0 ||
        parsed.data.rng.seed.length === 0
      ) {
        rngIssues.push("RNG seed/cursor 无效");
      }
      if (save.source_metadata_mode === "omit_catalog" && parsed.data.meta.sourceCatalogPresent) {
        sourceIssues.push("source catalog 已剥离但状态未标记");
      }
    }
  }
  checks.push(
    check(
      "SOURCE_IDS",
      sourceIssues.length === 0 ? "passed" : "failed",
      sourceIssues.length === 0 ? "sourceIds 与 catalog 标记通过" : "史料来源元数据无效",
      sourceIssues,
    ),
    check(
      "RNG_STATE",
      rngIssues.length === 0 ? "passed" : "failed",
      rngIssues.length === 0 ? "RNG seed 与 cursor 通过" : "RNG 状态无效",
      rngIssues,
    ),
  );

  const pending = transactionRows.filter((row) => row.status === "pending").map((row) => row.tx_id);
  checks.push(
    check(
      "PENDING_TRANSACTIONS",
      pending.length === 0 ? "passed" : "failed",
      pending.length === 0 ? "无孤立 pending transaction" : "存在孤立 pending transaction",
      pending,
    ),
  );

  return SaveValidationReportSchema.parse({
    valid: checks.every((item) => item.status !== "failed"),
    checks,
  });
}
