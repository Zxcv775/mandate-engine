import { DEFAULT_MEETING_LIMITS } from "@mandate/domain";
import { applyDatabaseMigrations, DATABASE_MIGRATIONS } from "@mandate/save-system";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

function databaseAt(version: number): DatabaseSync {
  const database = new DatabaseSync(":memory:", { allowExtension: false });
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of DATABASE_MIGRATIONS) {
    if (migration.toVersion > version) break;
    database.exec(migration.sql);
  }
  return database;
}

describe("review-session-history-migration", () => {
  it.each([4, 5, 6, 7, 8])(
    "upgrades schema v%s atomically to the timeline-safe ruling schema",
    (version) => {
      const database = databaseAt(version);
      try {
        applyDatabaseMigrations(database, FIXTURE_NOW);
        expect(
          (
            database.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(9);
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_session_versions'",
            )
            .get(),
        ).toEqual({ name: "meeting_session_versions" });
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(
          database
            .prepare("PRAGMA index_list(meeting_rulings)")
            .all()
            .find(
              (row) =>
                (row as { name: string }).name === "idx_meeting_rulings_timeline_idempotency",
            ),
        ).toMatchObject({ unique: 0 });
      } finally {
        database.close();
      }
    },
  );

  it("backfills a v7 meeting head and preserves its ruling through v9", () => {
    const database = databaseAt(7);
    try {
      database
        .prepare(
          `INSERT INTO saves (
             save_id, scenario_id, dynasty_id, title, status, head_revision,
             schema_version, state_version, lineage_id, parent_save_id,
             source_metadata_mode, created_at, updated_at, last_played_at, metadata_json
           ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 'full', ?, ?, NULL, '{}')`,
        )
        .run(
          "save_migration",
          "chongzhen-early",
          "ming",
          "migration",
          3,
          1,
          2,
          "lineage-migration",
          FIXTURE_NOW,
          FIXTURE_NOW,
        );
      database
        .prepare(
          `INSERT INTO meeting_sessions (
             meeting_id, save_id, type, status, title, purpose,
             created_at_revision, started_at_revision, concluded_at_revision,
             meeting_version, turn_number, participant_ids_json, chair_character_id,
             agenda_item_ids_json, current_agenda_item_id, current_speaker_id,
             pending_player_action_json, pending_agent_action_json, limits_json, used_turns,
             visibility, outcome_candidate_ids_json, pause_reason, failure_code,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          "meeting-v7",
          "save_migration",
          "imperial-council",
          "paused",
          "legacy meeting",
          "legacy purpose",
          1,
          2,
          7,
          2,
          JSON.stringify(["huang-liji"]),
          "emperor",
          JSON.stringify(["agenda-v7"]),
          "agenda-v7",
          JSON.stringify(DEFAULT_MEETING_LIMITS),
          2,
          "meeting",
          JSON.stringify([]),
          "legacy pause",
          FIXTURE_NOW,
          FIXTURE_NOW,
        );
      database
        .prepare(
          `INSERT INTO meeting_rulings (
             ruling_id, save_id, meeting_id, agenda_item_id, idempotency_key,
             request_hash, state_revision, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ruling-v7",
          "save_migration",
          "meeting-v7",
          "agenda-v7",
          "legacy-key",
          "a".repeat(64),
          3,
          JSON.stringify({ decisionType: "player-ruling" }),
          FIXTURE_NOW,
        );

      applyDatabaseMigrations(database, FIXTURE_NOW);
      const row = database
        .prepare(
          `SELECT state_revision, meeting_version, session_json
           FROM meeting_session_versions WHERE meeting_id = ?`,
        )
        .get("meeting-v7") as {
        state_revision: number;
        meeting_version: number;
        session_json: string;
      };
      expect(row).toMatchObject({ state_revision: 3, meeting_version: 7 });
      expect(JSON.parse(row.session_json)).toMatchObject({
        meetingId: "meeting-v7",
        status: "paused",
        meetingVersion: 7,
        pauseReason: "legacy pause",
      });
      expect(
        database
          .prepare(
            "SELECT ruling_id, idempotency_key, state_revision FROM meeting_rulings WHERE ruling_id = ?",
          )
          .get("ruling-v7"),
      ).toEqual({ ruling_id: "ruling-v7", idempotency_key: "legacy-key", state_revision: 3 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back the whole migration when a late schema step fails", () => {
    const database = databaseAt(7);
    try {
      database.exec("CREATE TABLE meeting_leak_assessment_versions (sentinel TEXT) STRICT");

      expect(() => applyDatabaseMigrations(database, FIXTURE_NOW)).toThrowError(
        /数据库迁移失败：008-meeting-session-history/,
      );
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(7);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_session_versions'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT migration_id FROM schema_migrations WHERE migration_id = ?")
          .get("008-meeting-session-history"),
      ).toBeUndefined();
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("restores the v8 unique ruling index when migration 009 fails after dropping it", () => {
    const database = databaseAt(8);
    try {
      database.exec(
        "CREATE INDEX idx_meeting_rulings_timeline_idempotency ON meeting_rulings(save_id)",
      );

      expect(() => applyDatabaseMigrations(database, FIXTURE_NOW)).toThrowError(
        /数据库迁移失败：009-meeting-ruling-timeline-idempotency/,
      );
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(8);
      expect(
        database
          .prepare("PRAGMA index_list(meeting_rulings)")
          .all()
          .find((row) => (row as { name: string }).name === "idx_meeting_rulings_idempotency"),
      ).toMatchObject({ unique: 1 });
      expect(
        database
          .prepare("SELECT migration_id FROM schema_migrations WHERE migration_id = ?")
          .get("009-meeting-ruling-timeline-idempotency"),
      ).toBeUndefined();
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
