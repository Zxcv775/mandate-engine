import type { Clock } from "@mandate/game-engine";
import { SystemClock } from "@mandate/game-engine";
import { DatabaseSync } from "node:sqlite";
import { applyDatabaseMigrations } from "./migrations";

export interface OpenSaveDatabaseOptions {
  clock?: Clock;
  busyTimeoutMs?: number;
  wal?: boolean;
}

export function openSaveDatabase(
  databasePath: string,
  options: OpenSaveDatabaseOptions = {},
): DatabaseSync {
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  if (options.wal !== false && databasePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  applyDatabaseMigrations(database, (options.clock ?? new SystemClock()).now().toISOString());
  database.enableDefensive(true);
  return database;
}
