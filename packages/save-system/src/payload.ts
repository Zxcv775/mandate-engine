import {
  GameStateSchema,
  type GameState,
  type SafeShareMode,
} from "@mandate/domain";
import { hashState, sha256Hex, stableStringify, type Clock } from "@mandate/game-engine";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { SaveSystemError } from "./errors";
import type { SqliteSaveRepository } from "./repository";
import { redactSensitiveString } from "./security";

export interface ExportPayloadOptions {
  includeSourceMetadata: boolean;
  safeShareMode: SafeShareMode;
}

function sanitizeState(
  input: GameState,
  options: ExportPayloadOptions,
): GameState {
  const state = structuredClone(input);
  state.meta.sourceCatalogPresent = options.includeSourceMetadata;
  if (options.safeShareMode === "strip_sealed_notes" || options.safeShareMode === "safe_share") {
    state.hidden.internalNotes = [];
    state.hidden.undiscoveredInformation = {};
  }
  if (options.safeShareMode === "safe_share") {
    state.hidden = {
      queuedEventIds: [],
      secretFlags: {},
      internalNotes: [],
      undiscoveredInformation: {},
    };
    state.flags = {};
    state.rng.seed = `safe-share-${sha256Hex(state.rng.seed).slice(0, 16)}`;
  }
  return GameStateSchema.parse(state);
}

function updateExportCopy(
  database: DatabaseSync,
  state: GameState,
  saveId: string,
  options: ExportPayloadOptions,
  clock: Clock,
): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM saves WHERE save_id <> ?").run(saveId);
    const row = database
      .prepare("SELECT title, metadata_json FROM saves WHERE save_id = ?")
      .get(saveId) as { title: string; metadata_json: string } | undefined;
    if (!row) throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    if (!options.includeSourceMetadata) delete metadata.sourceCatalog;
    const shouldFlatten =
      !options.includeSourceMetadata || options.safeShareMode !== "none";
    if (shouldFlatten) {
      database.prepare("DELETE FROM command_transactions WHERE save_id = ?").run(saveId);
      database.prepare("DELETE FROM save_snapshots WHERE save_id = ?").run(saveId);
      const stateHash = hashState(state);
      database
        .prepare(
          "INSERT INTO save_snapshots (snapshot_id, save_id, revision, checkpoint_kind, label, state_json, state_hash, created_at) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)",
        )
        .run(
          `snapshot_export_${randomUUID()}`,
          saveId,
          state.revision,
          "export-flattened",
          stableStringify(state),
          stateHash,
          clock.now().toISOString(),
        );
      metadata.headStateHash = stateHash;
    }
    if (options.safeShareMode === "safe_share") {
      // 安全分享：sealed 记忆属于绝不出境的私密数据（ADR-012）
      database.prepare("DELETE FROM character_memories WHERE visibility = 'sealed'").run();
    }
    const title =
      options.safeShareMode === "safe_share"
        ? redactSensitiveString(row.title)
        : row.title;
    database
      .prepare(
        "UPDATE saves SET title = ?, source_metadata_mode = ?, metadata_json = ? WHERE save_id = ?",
      )
      .run(
        title,
        options.includeSourceMetadata ? "full" : "omit_catalog",
        stableStringify(metadata),
        saveId,
      );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export async function createExportPayload(
  sourceDatabase: DatabaseSync,
  repository: SqliteSaveRepository,
  saveId: string,
  options: ExportPayloadOptions,
  clock: Clock,
): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-export-payload-"));
  const path = join(directory, "payload.sqlite");
  let copy: DatabaseSync | undefined;
  try {
    const state = sanitizeState(repository.loadHeadState(saveId), options);
    await backup(sourceDatabase, path);
    copy = new DatabaseSync(path, { allowExtension: false });
    updateExportCopy(copy, state, saveId, options, clock);
    const integrity = copy.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (!integrity.every((row) => row.integrity_check === "ok")) {
      throw new SaveSystemError("SAVE_EXPORT_FAILED", "导出 SQLite 完整性检查失败");
    }
    copy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copy.exec("VACUUM");
    copy.close();
    copy = undefined;
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (error instanceof SaveSystemError) throw error;
    throw new SaveSystemError("SAVE_EXPORT_FAILED", "导出 SQLite payload 失败", error);
  } finally {
    copy?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
