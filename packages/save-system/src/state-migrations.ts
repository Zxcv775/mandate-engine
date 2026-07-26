import { GAME_STATE_VERSION, GameStateSchema, type GameState } from "@mandate/domain";
import { sha256Hex, stableStringify } from "@mandate/game-engine";
import { SaveSystemError } from "./errors";

export interface StateDocumentMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  checksum: string;
  migrate(document: Record<string, unknown>): Record<string, unknown>;
}

const treasuryMigrationDescriptor = {
  id: "state-001-treasury-taels",
  fromVersion: 0,
  toVersion: 1,
  operation: "rename",
  from: "/country/treasury",
  to: "/country/treasuryTaels",
} as const;

export const STATE_DOCUMENT_MIGRATIONS: readonly StateDocumentMigration[] = [
  {
    id: treasuryMigrationDescriptor.id,
    fromVersion: treasuryMigrationDescriptor.fromVersion,
    toVersion: treasuryMigrationDescriptor.toVersion,
    checksum: sha256Hex(stableStringify(treasuryMigrationDescriptor)),
    migrate(document) {
      const next = structuredClone(document);
      const country = next.country;
      if (!country || typeof country !== "object") {
        throw new SaveSystemError("STATE_INVALID", "旧状态缺少 country");
      }
      const record = country as Record<string, unknown>;
      if (typeof record.treasury !== "number" || record.treasuryTaels !== undefined) {
        throw new SaveSystemError("STATE_INVALID", "旧状态 treasury 字段不符合迁移条件");
      }
      record.treasuryTaels = record.treasury;
      delete record.treasury;
      next.stateVersion = 1;
      return next;
    },
  },
];

export function migrateStatePointer(path: string, appliedMigrationIds: readonly string[]): string {
  if (
    appliedMigrationIds.includes(treasuryMigrationDescriptor.id) &&
    path === treasuryMigrationDescriptor.from
  ) {
    return treasuryMigrationDescriptor.to;
  }
  return path;
}

export interface StateMigrationResult {
  state: GameState;
  appliedMigrationIds: readonly string[];
}

export function migrateGameStateDocument(input: unknown): StateMigrationResult {
  if (!input || typeof input !== "object") {
    throw new SaveSystemError("STATE_INVALID", "状态文档必须是对象");
  }
  let document = structuredClone(input) as Record<string, unknown>;
  let version = document.stateVersion;
  if (!Number.isInteger(version) || Number(version) < 0) {
    throw new SaveSystemError("STATE_INVALID", "stateVersion 无效");
  }
  if (Number(version) > GAME_STATE_VERSION) {
    throw new SaveSystemError("SAVE_VERSION_UNSUPPORTED", "状态版本高于当前引擎");
  }
  const appliedMigrationIds: string[] = [];
  while (Number(version) < GAME_STATE_VERSION) {
    const migration = STATE_DOCUMENT_MIGRATIONS.find(
      (candidate) => candidate.fromVersion === Number(version),
    );
    if (!migration) {
      throw new SaveSystemError(
        "SAVE_VERSION_UNSUPPORTED",
        `stateVersion ${String(version)} 没有前向迁移路径`,
      );
    }
    document = migration.migrate(document);
    version = migration.toVersion;
    appliedMigrationIds.push(migration.id);
  }
  return { state: GameStateSchema.parse(document), appliedMigrationIds };
}
