import { createScenarioLoader } from "@mandate/data-loader";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import {
  GameStateSchema,
  MeetingSessionStateSchema,
  type GameCommand,
  type MeetingOutcomeCandidate,
} from "@mandate/domain";
import { FixedClock, hashState, stableStringify } from "@mandate/game-engine";
import type { LLMProvider } from "@mandate/llm-adapters";
import { createSaveSystem, parseSavePackage, type SaveSystem } from "@mandate/save-system";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import {
  SAFE_SHARE_REFERENCE_CONTRACT,
  isRegisteredSafeShareStructuredIdField,
} from "../packages/save-system/src/payload";
import { FIXTURE_NOW } from "./helpers/character-fixtures";
import { makeAgendaItem, makeSession, makeTurn } from "./helpers/meeting-fixtures";

const SECRET_MEETING_ID = "secret-meeting-marker";
const SECRET_OUTCOME_ID = "secret-outcome-marker";
const SECRET_TITLE = "SECRET_MEETING_TITLE_MARKER";
const SECRET_AGENDA = "SECRET_AGENDA_MARKER";
const SECRET_TURN_ID = "secret-turn-marker";
const SECRET_AGENDA_ID = "secret-agenda";
const SECRET_RULING_ID = "secret-ruling-marker";
const PUBLIC_MEETING_ID = "public-meeting-marker";
const PUBLIC_OUTCOME_ID = "public-outcome-marker";
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setup(name: string): Promise<{ system: SaveSystem; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), `mandate-${name}-`));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(async () => {
    system.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { system, directory };
}

function command(
  commandType: GameCommand["commandType"],
  baseRevision: number,
  payload: Record<string, unknown>,
): GameCommand {
  return {
    commandId: `cmd_${commandType}_${baseRevision}`,
    commandType,
    saveId: "save_safe_origin",
    baseRevision,
    actor: { type: "system", id: "meeting-director" },
    payload,
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

function outcome(
  meetingId: string,
  outcomeCandidateId: string,
  agendaItemId: string,
  marker: string,
): MeetingOutcomeCandidate {
  return {
    outcomeCandidateId,
    meetingId,
    saveId: "save_safe_origin",
    agendaItemId,
    type: "policy-proposal",
    title: marker,
    summary: marker,
    proposerIds: ["huang-liji"],
    supporterIds: [],
    opponentIds: [],
    rationale: [marker],
    risks: [],
    sourceTurnIds: meetingId === SECRET_MEETING_ID ? [SECRET_TURN_ID] : ["public-turn-marker"],
    status: "accepted",
    unsupportedCommand: false,
    createdAtRevision: 2,
    createdAt: FIXTURE_NOW,
  };
}

function dumpAllDatabaseValues(database: DatabaseSync): string {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>;
  const values: unknown[] = [];
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const rows = database.prepare(`SELECT * FROM ${quoted}`).all() as unknown as Array<
      Record<string, SQLInputValue>
    >;
    values.push(
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
          ]),
        ),
      ),
    );
  }
  return JSON.stringify(values, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function containsExactValue(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, target));
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some((item) => containsExactValue(item, target))
  );
}

function databaseHasStructuredReference(database: DatabaseSync, target: string): boolean {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>;
  for (const { name: table } of tables) {
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    const columns = database
      .prepare(`PRAGMA table_info(${quotedTable})`)
      .all() as unknown as Array<{
      name: string;
    }>;
    for (const { name: column } of columns) {
      if (!column.endsWith("_id") && !column.endsWith("_ids") && !column.endsWith("_json")) {
        continue;
      }
      const quotedColumn = `"${column.replaceAll('"', '""')}"`;
      const rows = database
        .prepare(
          `SELECT ${quotedColumn} AS value FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`,
        )
        .all() as unknown as Array<{ value: unknown }>;
      for (const { value } of rows) {
        if (value === target) return true;
        if (column.endsWith("_json") && typeof value === "string") {
          try {
            if (containsExactValue(JSON.parse(value), target)) return true;
          } catch {
            // 非法 JSON 由正式存档完整性校验负责；此 helper 只做精确结构化引用搜索。
          }
        }
      }
    }
  }
  return false;
}

async function installEventQueueFixture(
  system: SaveSystem,
  input: { pendingEventIds: string[]; processedEventIds: string[]; privateEventIds: string[] },
): Promise<void> {
  const state = GameStateSchema.parse(await system.service.loadState("save_safe_origin"));
  state.eventQueue.pendingEventIds = input.pendingEventIds;
  state.eventQueue.processedEventIds = input.processedEventIds;
  state.hidden.queuedEventIds = input.privateEventIds;
  const parsed = GameStateSchema.parse(state);
  const stateHash = hashState(parsed);
  const database = system.database;
  database
    .prepare("DELETE FROM save_snapshots WHERE save_id = ? AND revision = ?")
    .run(parsed.saveId, parsed.revision);
  database
    .prepare(
      `INSERT INTO save_snapshots (
         snapshot_id, save_id, revision, checkpoint_kind, label,
         state_json, state_hash, created_at
       ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`,
    )
    .run(
      `snapshot_event_fixture_${parsed.revision}`,
      parsed.saveId,
      parsed.revision,
      "safe-share-event-fixture",
      stableStringify(parsed),
      stateHash,
      FIXTURE_NOW,
    );
  const save = database
    .prepare("SELECT metadata_json FROM saves WHERE save_id = ?")
    .get(parsed.saveId) as { metadata_json: string };
  const metadata = JSON.parse(save.metadata_json) as Record<string, unknown>;
  metadata.headStateHash = stateHash;
  database
    .prepare("UPDATE saves SET metadata_json = ? WHERE save_id = ?")
    .run(stableStringify(metadata), parsed.saveId);
}

async function installMeetingParticipantFixture(
  system: SaveSystem,
  input: {
    meetingId: string;
    participantIds: string[];
    publicEventIds?: string[];
    privateEventIds?: string[];
  },
): Promise<void> {
  const state = GameStateSchema.parse(await system.service.loadState("save_safe_origin"));
  state.meetings[input.meetingId]!.participantIds = [...input.participantIds];
  state.eventQueue.pendingEventIds = [...(input.publicEventIds ?? [])];
  state.hidden.queuedEventIds = [...(input.privateEventIds ?? [])];
  const parsed = GameStateSchema.parse(state);
  const stateHash = hashState(parsed);
  const database = system.database;
  database
    .prepare("DELETE FROM save_snapshots WHERE save_id = ? AND revision = ?")
    .run(parsed.saveId, parsed.revision);
  database
    .prepare(
      `INSERT INTO save_snapshots (
         snapshot_id, save_id, revision, checkpoint_kind, label,
         state_json, state_hash, created_at
       ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`,
    )
    .run(
      `snapshot_participant_fixture_${parsed.revision}`,
      parsed.saveId,
      parsed.revision,
      "safe-share-participant-fixture",
      stableStringify(parsed),
      stateHash,
      FIXTURE_NOW,
    );
  const save = database
    .prepare("SELECT metadata_json FROM saves WHERE save_id = ?")
    .get(parsed.saveId) as { metadata_json: string };
  const metadata = JSON.parse(save.metadata_json) as Record<string, unknown>;
  metadata.headStateHash = stateHash;
  database
    .prepare("UPDATE saves SET metadata_json = ? WHERE save_id = ?")
    .run(stableStringify(metadata), parsed.saveId);
}

describe("review-safe-share-policy-origin", () => {
  it("removes every secret meeting source reference while preserving public policy state", async () => {
    const { system: source, directory } = await setup("safe-origin-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "safe origin",
      seed: "safe-origin",
    });

    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId: SECRET_MEETING_ID,
        meetingType: "secret-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "sealed",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId: SECRET_MEETING_ID,
        saveId: "save_safe_origin",
        type: "secret-council",
        visibility: "sealed",
        title: SECRET_TITLE,
        createdAtRevision: 1,
        agendaItemIds: [SECRET_AGENDA_ID],
        currentAgendaItemId: SECRET_AGENDA_ID,
      }),
      [],
      [
        makeAgendaItem({
          agendaItemId: SECRET_AGENDA_ID,
          meetingId: SECRET_MEETING_ID,
          title: SECRET_AGENDA,
          description: SECRET_AGENDA,
          visibility: "sealed",
          relatedEntityIds: [SECRET_OUTCOME_ID],
        }),
      ],
    );
    source.meetings.appendTurn(
      makeTurn({
        turnId: SECRET_TURN_ID,
        meetingId: SECRET_MEETING_ID,
        saveId: "save_safe_origin",
        agendaItemId: SECRET_AGENDA_ID,
        publicText: SECRET_AGENDA,
        visibility: "sealed",
        stateRevision: 1,
      }),
    );
    source.meetings.insertOutcomeCandidate(
      outcome(SECRET_MEETING_ID, SECRET_OUTCOME_ID, SECRET_AGENDA_ID, SECRET_AGENDA),
    );
    source.meetings.insertRuling({
      rulingId: SECRET_RULING_ID,
      saveId: "save_safe_origin",
      meetingId: SECRET_MEETING_ID,
      agendaItemId: SECRET_AGENDA_ID,
      idempotencyKey: "secret-ruling-key",
      requestHash: "a".repeat(64),
      stateRevision: 1,
      result: { decisionType: "player-ruling" },
      createdAt: FIXTURE_NOW,
    });
    source.meetings.insertLeakAssessment({
      meetingId: SECRET_MEETING_ID,
      saveId: "save_safe_origin",
      riskScore: 10,
      riskLevel: "low",
      contributingFactors: ["秘密会议"],
      potentialAudienceIds: [],
      createdAtRevision: 1,
      createdAt: FIXTURE_NOW,
    });
    const secretMemory = source.characterMemories.insertMemory({
      saveId: "save_safe_origin",
      characterId: "huang-liji",
      candidate: {
        type: "episodic",
        content: "秘密会议记忆",
        relatedCharacterIds: [],
        relatedEntityIds: [SECRET_MEETING_ID, SECRET_OUTCOME_ID, SECRET_TURN_ID],
        topicTags: ["秘密会议"],
        sourceType: "observed",
        importance: 80,
        visibility: "private",
      },
      sourceRevision: 1,
      sourceMeetingId: SECRET_MEETING_ID,
      confidence: 100,
    });

    await source.service.commitCommand(
      command("policy.propose", 1, {
        policyId: "policy-from-secret",
        templateId: "policy-zhenji-shaanxi",
        origin: {
          kind: "meeting",
          meetingId: SECRET_MEETING_ID,
          outcomeCandidateId: SECRET_OUTCOME_ID,
        },
        sourceIds: [
          "ming-shi",
          SECRET_MEETING_ID,
          SECRET_AGENDA_ID,
          SECRET_OUTCOME_ID,
          SECRET_TURN_ID,
          SECRET_RULING_ID,
          secretMemory.memoryId,
        ],
      }),
    );
    await source.service.commitCommand(
      command("meeting.create", 2, {
        meetingId: PUBLIC_MEETING_ID,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId: PUBLIC_MEETING_ID,
        saveId: "save_safe_origin",
        title: "公开廷议",
        createdAtRevision: 3,
        agendaItemIds: ["public-agenda"],
        currentAgendaItemId: "public-agenda",
      }),
      [],
      [makeAgendaItem({ agendaItemId: "public-agenda", meetingId: PUBLIC_MEETING_ID })],
    );
    source.meetings.insertOutcomeCandidate(
      outcome(PUBLIC_MEETING_ID, PUBLIC_OUTCOME_ID, "public-agenda", "公开候选"),
    );
    await source.service.commitCommand(
      command("policy.propose", 3, {
        policyId: "policy-from-public",
        templateId: "policy-zhenji-shaanxi",
        origin: {
          kind: "meeting",
          meetingId: PUBLIC_MEETING_ID,
          outcomeCandidateId: PUBLIC_OUTCOME_ID,
        },
      }),
    );

    const original = await source.service.loadState("save_safe_origin");
    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const parsed = parseSavePackage(exported.bytes);
    const payloadPath = join(directory, "safe-payload.sqlite");
    await writeFile(payloadPath, parsed.payload);
    const payloadDatabase = new DatabaseSync(payloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    let databaseDump: string;
    try {
      databaseDump = dumpAllDatabaseValues(payloadDatabase);
    } finally {
      payloadDatabase.close();
    }

    const forbiddenIds = [
      SECRET_MEETING_ID,
      SECRET_AGENDA_ID,
      SECRET_OUTCOME_ID,
      SECRET_TITLE,
      SECRET_AGENDA,
      SECRET_TURN_ID,
      SECRET_RULING_ID,
      secretMemory.memoryId,
    ];
    for (const marker of forbiddenIds) {
      expect(databaseDump).not.toContain(marker);
    }

    const { system: target } = await setup("safe-origin-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedState = await target.service.loadState(imported.saveId);
    expect(importedState.meetings[SECRET_MEETING_ID]).toBeUndefined();
    expect(importedState.policies["policy-from-secret"]).toMatchObject({
      status: original.policies["policy-from-secret"]?.status,
      currentStageIndex: original.policies["policy-from-secret"]?.currentStageIndex,
      responsibleCharacterIds: original.policies["policy-from-secret"]?.responsibleCharacterIds,
      origin: { kind: "redacted" },
    });
    expect(importedState.policies["policy-from-secret"]?.sourceIds).toEqual(["ming-shi"]);
    expect(importedState.policies["policy-from-public"]?.origin).toEqual({
      kind: "meeting",
      meetingId: PUBLIC_MEETING_ID,
      outcomeCandidateId: PUBLIC_OUTCOME_ID,
    });
    expect(target.meetings.getSession(SECRET_MEETING_ID)).toBeNull();
    expect(target.meetings.getSession(PUBLIC_MEETING_ID)?.title).toBe("公开廷议");
    expect(await target.service.validateSave(imported.saveId)).toMatchObject({ valid: true });

    await target.service.commitCommand(
      command("country.adjust-resource", importedState.revision, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "safe-share rollback probe",
      }),
    );
    const rolledBack = await target.service.rollback(imported.saveId, {
      targetRevision: importedState.revision,
    });
    const rolledBackState = await target.service.loadState(imported.saveId);
    expect(rolledBack.resultRevision).toBe(importedState.revision + 2);
    for (const marker of forbiddenIds) {
      expect(JSON.stringify(rolledBackState)).not.toContain(marker);
    }

    const targetApp = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      saveSystem: target,
      logger: false,
    });
    cleanup.push(() => targetApp.close());
    const publicPolicy = await targetApp.inject({
      method: "GET",
      url: `/api/saves/${imported.saveId}/policies/policy-from-secret`,
    });
    const debugPolicy = await targetApp.inject({
      method: "GET",
      url: `/api/debug/saves/${imported.saveId}/policies/policy-from-secret/truth`,
    });
    expect(publicPolicy.statusCode).toBe(200);
    expect(debugPolicy.statusCode).toBe(200);
    for (const marker of forbiddenIds) {
      expect(publicPolicy.body).not.toContain(marker);
      expect(debugPolicy.body).not.toContain(marker);
    }
    expect(await source.service.loadState("save_safe_origin")).toEqual(original);

    const reexported = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const reparsed = parseSavePackage(reexported.bytes);
    const secondPayloadPath = join(directory, "safe-payload-second.sqlite");
    await writeFile(secondPayloadPath, reparsed.payload);
    const secondPayloadDatabase = new DatabaseSync(secondPayloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      const secondDump = dumpAllDatabaseValues(secondPayloadDatabase);
      for (const marker of forbiddenIds) expect(secondDump).not.toContain(marker);
    } finally {
      secondPayloadDatabase.close();
    }

    const { system: forkTarget } = await setup("safe-origin-fork");
    await forkTarget.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "local divergent line",
      seed: "local-divergent-line",
    });
    const forked = await forkTarget.service.importSave({ bytes: exported.bytes });
    expect(forked.result).toBe("forked");
    const forkState = await forkTarget.service.loadState(forked.saveId);
    expect(forkState.policies["policy-from-secret"]?.sourceIds).toEqual(["ming-shi"]);
    expect(forkState.policies["policy-from-public"]?.origin).toEqual({
      kind: "meeting",
      meetingId: PUBLIC_MEETING_ID,
      outcomeCandidateId: PUBLIC_OUTCOME_ID,
    });
    for (const marker of forbiddenIds) {
      expect(JSON.stringify(forkState)).not.toContain(marker);
    }
  });

  it("preserves a public meeting while removing a private agenda closure", async () => {
    const meetingId = "mixed-public-meeting";
    const publicAgendaId = "mixed-public-agenda";
    const privateAgendaId = "mixed-private-agenda";
    const publicTurnId = "mixed-public-turn";
    const privateTurnId = "mixed-private-turn";
    const publicOutcomeId = "mixed-public-outcome";
    const privateOutcomeId = "mixed-private-outcome";
    const privateRulingId = "mixed-private-ruling";
    const narrative = `公开叙事保留 prefix-${privateAgendaId}-suffix`;
    const { system: source, directory } = await setup("safe-mixed-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "mixed visibility",
      seed: "mixed-visibility",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId,
        saveId: "save_safe_origin",
        title: "公开会议",
        createdAtRevision: 1,
        agendaItemIds: [publicAgendaId, privateAgendaId],
        currentAgendaItemId: publicAgendaId,
      }),
      [],
      [
        makeAgendaItem({
          agendaItemId: publicAgendaId,
          meetingId,
          title: "公开议程",
          sequence: 0,
          visibility: "meeting",
        }),
        makeAgendaItem({
          agendaItemId: privateAgendaId,
          meetingId,
          title: "私密议程",
          sequence: 1,
          visibility: "private",
        }),
      ],
    );
    source.meetings.appendTurn(
      makeTurn({
        turnId: publicTurnId,
        meetingId,
        saveId: "save_safe_origin",
        agendaItemId: publicAgendaId,
        turnNumber: 0,
        publicText: narrative,
        visibility: "meeting",
        stateRevision: 1,
      }),
    );
    source.meetings.appendTurn(
      makeTurn({
        turnId: privateTurnId,
        meetingId,
        saveId: "save_safe_origin",
        agendaItemId: privateAgendaId,
        turnNumber: 1,
        publicText: "私密议程发言",
        // 子实体的保密性由 private agenda 继承，验证闭包而非只验证自身 visibility seed。
        visibility: "meeting",
        stateRevision: 1,
      }),
    );
    source.meetings.insertOutcomeCandidate({
      ...outcome(meetingId, publicOutcomeId, publicAgendaId, "公开候选"),
      sourceTurnIds: [publicTurnId],
    });
    source.meetings.insertOutcomeCandidate({
      ...outcome(meetingId, privateOutcomeId, privateAgendaId, "私密候选"),
      sourceTurnIds: [privateTurnId],
    });
    source.meetings.insertRuling({
      rulingId: privateRulingId,
      saveId: "save_safe_origin",
      meetingId,
      agendaItemId: privateAgendaId,
      idempotencyKey: "mixed-private-ruling-key",
      requestHash: "b".repeat(64),
      stateRevision: 1,
      result: { outcomeCandidateId: privateOutcomeId },
      createdAt: FIXTURE_NOW,
    });
    source.meetings.insertLeakAssessment({
      meetingId,
      saveId: "save_safe_origin",
      riskScore: 30,
      riskLevel: "moderate",
      contributingFactors: ["私密议程泄密评估"],
      potentialAudienceIds: [],
      createdAtRevision: 1,
      createdAt: FIXTURE_NOW,
    });
    const privateMemory = source.characterMemories.insertMemory({
      saveId: "save_safe_origin",
      characterId: "huang-liji",
      candidate: {
        type: "episodic",
        content: "私密议程记忆",
        relatedCharacterIds: [],
        relatedEntityIds: [privateAgendaId, privateTurnId, privateOutcomeId],
        topicTags: ["私密议程"],
        sourceType: "observed",
        importance: 70,
        visibility: "private",
      },
      sourceRevision: 1,
      sourceMeetingId: meetingId,
      confidence: 100,
    });
    await source.service.commitCommand(
      command("policy.propose", 1, {
        policyId: "policy-from-private-agenda",
        templateId: "policy-zhenji-shaanxi",
        origin: {
          kind: "meeting",
          meetingId,
          outcomeCandidateId: privateOutcomeId,
        },
        sourceIds: [
          "ming-shi",
          publicAgendaId,
          publicTurnId,
          publicOutcomeId,
          privateAgendaId,
          privateTurnId,
          privateOutcomeId,
          privateRulingId,
          privateMemory.memoryId,
        ],
      }),
    );

    const originalState = await source.service.loadState("save_safe_origin");
    const originalDatabase = dumpAllDatabaseValues(source.database);
    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const parsed = parseSavePackage(exported.bytes);
    const payloadPath = join(directory, "mixed-safe-payload.sqlite");
    await writeFile(payloadPath, parsed.payload);
    const payloadDatabase = new DatabaseSync(payloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    const forbiddenIds = [
      privateAgendaId,
      privateTurnId,
      privateOutcomeId,
      privateRulingId,
      privateMemory.memoryId,
    ];
    try {
      for (const id of forbiddenIds)
        expect(databaseHasStructuredReference(payloadDatabase, id)).toBe(false);
      expect(dumpAllDatabaseValues(payloadDatabase)).toContain(narrative);
    } finally {
      payloadDatabase.close();
    }

    const { system: target } = await setup("safe-mixed-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedState = await target.service.loadState(imported.saveId);
    expect(importedState.meetings[meetingId]).toBeDefined();
    expect(importedState.policies["policy-from-private-agenda"]?.origin).toEqual({
      kind: "redacted",
    });
    expect(importedState.policies["policy-from-private-agenda"]?.sourceIds).toEqual([
      "ming-shi",
      publicAgendaId,
      publicTurnId,
      publicOutcomeId,
    ]);
    expect(target.meetings.listAgendaItems(meetingId).map((item) => item.agendaItemId)).toEqual([
      publicAgendaId,
    ]);
    expect(target.meetings.listTurns(meetingId).turns).toMatchObject([
      { turnId: publicTurnId, publicText: narrative },
    ]);
    expect(
      target.meetings.listOutcomeCandidates(meetingId).map((item) => item.outcomeCandidateId),
    ).toEqual([publicOutcomeId]);
    expect(target.meetings.getLeakAssessment(meetingId)).toBeNull();
    expect(await target.service.validateSave(imported.saveId)).toMatchObject({ valid: true });
    for (const id of forbiddenIds) expect(containsExactValue(importedState, id)).toBe(false);

    const targetApp = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      saveSystem: target,
      logger: false,
    });
    cleanup.push(() => targetApp.close());
    const publicPolicy = await targetApp.inject({
      method: "GET",
      url: `/api/saves/${imported.saveId}/policies/policy-from-private-agenda`,
    });
    const debugPolicy = await targetApp.inject({
      method: "GET",
      url: `/api/debug/saves/${imported.saveId}/policies/policy-from-private-agenda/truth`,
    });
    expect(publicPolicy.statusCode).toBe(200);
    expect(debugPolicy.statusCode).toBe(200);
    for (const id of forbiddenIds) {
      expect(containsExactValue(publicPolicy.json(), id)).toBe(false);
      expect(containsExactValue(debugPolicy.json(), id)).toBe(false);
    }

    await target.service.commitCommand(
      command("country.adjust-resource", importedState.revision, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "mixed safe-share rollback probe",
      }),
    );
    await target.service.rollback(imported.saveId, { targetRevision: importedState.revision });
    const replayedState = await target.service.loadState(imported.saveId);
    for (const id of forbiddenIds) expect(containsExactValue(replayedState, id)).toBe(false);

    const reexported = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const reparsed = parseSavePackage(reexported.bytes);
    const secondPayloadPath = join(directory, "mixed-safe-payload-second.sqlite");
    await writeFile(secondPayloadPath, reparsed.payload);
    const secondPayload = new DatabaseSync(secondPayloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      for (const id of forbiddenIds)
        expect(databaseHasStructuredReference(secondPayload, id)).toBe(false);
    } finally {
      secondPayload.close();
    }

    const { system: forkTarget } = await setup("safe-mixed-fork");
    await forkTarget.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "mixed local divergent line",
      seed: "mixed-local-divergent-line",
    });
    const forked = await forkTarget.service.importSave({ bytes: exported.bytes });
    expect(forked.result).toBe("forked");
    const forkState = await forkTarget.service.loadState(forked.saveId);
    for (const id of forbiddenIds) expect(containsExactValue(forkState, id)).toBe(false);

    expect(await source.service.loadState("save_safe_origin")).toEqual(originalState);
    expect(dumpAllDatabaseValues(source.database)).toBe(originalDatabase);
  });

  it("keeps cross-type public identities while removing typed private descendants", async () => {
    const meetingId = "typed-public-meeting";
    const publicAgendaId = "typed-public-agenda";
    const sharedAgendaOutcomeId = "typed-shared-agenda-outcome";
    const publicTurnId = "typed-public-turn";
    const privateTurnId = "typed-private-turn";
    const privateOutcomeId = "typed-private-outcome";
    const sharedRulingOutcomeId = "typed-shared-ruling-outcome";
    const sharedActionEventId = "typed-shared-action-event";
    const publicEventId = "typed-public-event";
    const privateEventId = "typed-private-event";
    const unknownReferenceId = "typed-unknown-reference";
    const { system: source, directory } = await setup("safe-typed-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "typed safe share",
      seed: "typed-safe-share",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    const initialSession = makeSession("waiting-for-agent", {
      meetingId,
      saveId: "save_safe_origin",
      title: "typed public meeting",
      createdAtRevision: 1,
      agendaItemIds: [publicAgendaId, sharedAgendaOutcomeId],
      currentAgendaItemId: publicAgendaId,
      pendingAgentAction: {
        actionId: sharedActionEventId,
        characterId: "huang-liji",
        responseMode: "speech",
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: FIXTURE_NOW,
      },
    });
    source.meetings.createSession(
      initialSession,
      [],
      [
        makeAgendaItem({
          agendaItemId: publicAgendaId,
          meetingId,
          title: "typed public agenda",
          sequence: 0,
          visibility: "meeting",
          relatedEntityIds: [sharedActionEventId, "huang-liji", unknownReferenceId],
        }),
        makeAgendaItem({
          agendaItemId: sharedAgendaOutcomeId,
          meetingId,
          title: "typed private agenda",
          sequence: 1,
          visibility: "private",
        }),
      ],
    );
    source.meetings.updateSession(
      {
        ...initialSession,
        status: "scheduled",
        meetingVersion: 2,
        pendingAgentAction: undefined,
      },
      1,
    );
    source.meetings.appendTurn(
      makeTurn({
        turnId: publicTurnId,
        meetingId,
        saveId: "save_safe_origin",
        agendaItemId: publicAgendaId,
        turnNumber: 0,
        publicText: "typed public turn",
        visibility: "meeting",
        stateRevision: 1,
      }),
    );
    source.meetings.appendTurn(
      makeTurn({
        turnId: privateTurnId,
        meetingId,
        saveId: "save_safe_origin",
        agendaItemId: sharedAgendaOutcomeId,
        turnNumber: 1,
        actionId: sharedActionEventId,
        publicText: "typed private turn",
        visibility: "meeting",
        stateRevision: 1,
      }),
    );
    source.meetings.insertOutcomeCandidate({
      ...outcome(meetingId, sharedAgendaOutcomeId, publicAgendaId, "shared agenda outcome"),
      sourceTurnIds: [publicTurnId],
    });
    source.meetings.insertOutcomeCandidate({
      ...outcome(meetingId, sharedRulingOutcomeId, publicAgendaId, "shared ruling outcome"),
      sourceTurnIds: [publicTurnId],
    });
    source.meetings.insertOutcomeCandidate({
      ...outcome(meetingId, privateOutcomeId, sharedAgendaOutcomeId, "private outcome"),
      sourceTurnIds: [privateTurnId],
    });
    source.meetings.insertRuling({
      rulingId: sharedRulingOutcomeId,
      saveId: "save_safe_origin",
      meetingId,
      // 公开议程：该 ruling 只能经 result.outcomeCandidateId 的深层边进入 forbidden。
      agendaItemId: publicAgendaId,
      idempotencyKey: "typed-deep-ruling-key",
      requestHash: "c".repeat(64),
      stateRevision: 1,
      result: { outcomeCandidateId: privateOutcomeId },
      createdAt: FIXTURE_NOW,
    });
    await source.service.commitCommand(
      command("policy.propose", 1, {
        policyId: "policy-typed-private-origin",
        templateId: "policy-zhenji-shaanxi",
        origin: { kind: "meeting", meetingId, outcomeCandidateId: privateOutcomeId },
        sourceIds: [
          "ming-shi",
          sharedAgendaOutcomeId,
          sharedRulingOutcomeId,
          publicTurnId,
          unknownReferenceId,
          privateOutcomeId,
          privateTurnId,
        ],
      }),
    );
    await installEventQueueFixture(source, {
      pendingEventIds: [publicEventId, privateEventId, sharedActionEventId],
      processedEventIds: [sharedActionEventId, privateEventId],
      privateEventIds: [privateEventId],
    });

    const originalState = await source.service.loadState("save_safe_origin");
    const originalDatabase = dumpAllDatabaseValues(source.database);
    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const parsed = parseSavePackage(exported.bytes);
    const payloadPath = join(directory, "typed-safe-payload.sqlite");
    await writeFile(payloadPath, parsed.payload);
    const payloadDatabase = new DatabaseSync(payloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      expect(
        payloadDatabase
          .prepare("SELECT agenda_item_id FROM meeting_agenda_items ORDER BY agenda_item_id")
          .all(),
      ).toEqual([{ agenda_item_id: publicAgendaId }]);
      expect(
        payloadDatabase
          .prepare(
            "SELECT outcome_candidate_id FROM meeting_outcome_candidates ORDER BY outcome_candidate_id",
          )
          .all(),
      ).toEqual([
        { outcome_candidate_id: sharedAgendaOutcomeId },
        { outcome_candidate_id: sharedRulingOutcomeId },
      ]);
      expect(payloadDatabase.prepare("SELECT ruling_id FROM meeting_rulings").all()).toEqual([]);
      const histories = payloadDatabase
        .prepare(
          "SELECT session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY meeting_version",
        )
        .all(meetingId) as unknown as Array<{ session_json: string }>;
      expect(histories.length).toBeGreaterThan(0);
      for (const history of histories) {
        const session = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(session.pendingAgentAction).toBeUndefined();
      }
    } finally {
      payloadDatabase.close();
    }

    const { system: target } = await setup("safe-typed-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedState = await target.service.loadState(imported.saveId);
    expect(importedState.eventQueue).toEqual({
      pendingEventIds: [publicEventId, sharedActionEventId],
      processedEventIds: [sharedActionEventId],
    });
    expect(importedState.policies["policy-typed-private-origin"]?.origin).toEqual({
      kind: "redacted",
    });
    expect(importedState.policies["policy-typed-private-origin"]?.sourceIds).toEqual([
      "ming-shi",
      publicTurnId,
    ]);
    expect(target.meetings.listAgendaItems(meetingId)).toMatchObject([
      { agendaItemId: publicAgendaId, relatedEntityIds: ["huang-liji"] },
    ]);
    expect(
      target.meetings.listOutcomeCandidates(meetingId).map((item) => item.outcomeCandidateId),
    ).toEqual([sharedAgendaOutcomeId, sharedRulingOutcomeId]);
    expect(
      target.meetings.getRulingByIdempotencyKey(
        imported.saveId,
        meetingId,
        "typed-deep-ruling-key",
      ),
    ).toBeNull();
    expect(target.meetings.getSession(meetingId)?.pendingAgentAction).toBeUndefined();
    expect(await target.service.validateSave(imported.saveId)).toMatchObject({ valid: true });

    const targetApp = await buildApp({
      config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
      saveSystem: target,
      logger: false,
    });
    cleanup.push(() => targetApp.close());
    for (const url of [
      `/api/saves/${imported.saveId}/policies/policy-typed-private-origin`,
      `/api/debug/saves/${imported.saveId}/policies/policy-typed-private-origin/truth`,
    ]) {
      const response = await targetApp.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(containsExactValue(response.json(), privateOutcomeId)).toBe(false);
      expect(containsExactValue(response.json(), privateTurnId)).toBe(false);
    }

    await target.service.commitCommand(
      command("country.adjust-resource", importedState.revision, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "typed safe-share rollback probe",
      }),
    );
    await target.service.rollback(imported.saveId, { targetRevision: importedState.revision });
    const replayedState = await target.service.loadState(imported.saveId);
    expect(replayedState.eventQueue).toEqual(importedState.eventQueue);
    expect(replayedState.policies["policy-typed-private-origin"]?.origin).toEqual({
      kind: "redacted",
    });

    const reexported = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const reparsed = parseSavePackage(reexported.bytes);
    const secondPayloadPath = join(directory, "typed-safe-payload-second.sqlite");
    await writeFile(secondPayloadPath, reparsed.payload);
    const secondPayload = new DatabaseSync(secondPayloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      const row = secondPayload
        .prepare("SELECT state_json FROM save_snapshots ORDER BY revision DESC LIMIT 1")
        .get() as { state_json: string };
      expect(GameStateSchema.parse(JSON.parse(row.state_json)).eventQueue).toEqual(
        importedState.eventQueue,
      );
    } finally {
      secondPayload.close();
    }

    const { system: forkTarget } = await setup("safe-typed-fork");
    await forkTarget.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "typed divergent line",
      seed: "typed-divergent-line",
    });
    const forked = await forkTarget.service.importSave({ bytes: exported.bytes });
    expect(forked.result).toBe("forked");
    const forkState = await forkTarget.service.loadState(forked.saveId);
    expect(forkState.eventQueue).toEqual(importedState.eventQueue);
    expect(forkState.policies["policy-typed-private-origin"]?.sourceIds).toEqual([
      "ming-shi",
      publicTurnId,
    ]);
    expect(forkState.policies["policy-typed-private-origin"]?.origin).toEqual({
      kind: "redacted",
    });
    expect(await source.service.loadState("save_safe_origin")).toEqual(originalState);
    expect(dumpAllDatabaseValues(source.database)).toBe(originalDatabase);
  });

  it("filters only private event identities from event queue arrays", async () => {
    const publicEventId = "typed-event-public-control";
    const privateEventId = "typed-event-private-control";
    const { system: source } = await setup("safe-event-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "event typed safe share",
      seed: "event-typed-safe-share",
    });
    await installEventQueueFixture(source, {
      pendingEventIds: [publicEventId, privateEventId],
      processedEventIds: [privateEventId, publicEventId],
      privateEventIds: [privateEventId],
    });
    const originalState = await source.service.loadState("save_safe_origin");
    const originalDatabase = dumpAllDatabaseValues(source.database);
    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const { system: target } = await setup("safe-event-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    expect((await target.service.loadState(imported.saveId)).eventQueue).toEqual({
      pendingEventIds: [publicEventId],
      processedEventIds: [publicEventId],
    });
    expect(await source.service.loadState("save_safe_origin")).toEqual(originalState);
    expect(dumpAllDatabaseValues(source.database)).toBe(originalDatabase);
  });

  it("removes a private pending agent reservation before its turn is written", async () => {
    const meetingId = "pending-history-meeting";
    const publicAgendaId = "pending-history-public-agenda";
    const privateAgendaId = "pending-history-private-agenda";
    const privateActionId = "pending-history-private-action";
    const publicMeetingId = "pending-public-control-meeting";
    const publicControlAgendaId = "pending-public-control-agenda";
    const publicActionId = "pending-public-control-action";
    const { system: source, directory } = await setup("safe-pending-history-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "pending history safe share",
      seed: "pending-history-safe-share",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    const pendingSession = makeSession("waiting-for-agent", {
      meetingId,
      saveId: "save_safe_origin",
      title: "pending history meeting",
      createdAtRevision: 1,
      agendaItemIds: [publicAgendaId, privateAgendaId],
      currentAgendaItemId: privateAgendaId,
      pendingAgentAction: {
        actionId: privateActionId,
        characterId: "huang-liji",
        responseMode: "speech",
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: FIXTURE_NOW,
      },
    });
    source.meetings.createSession(
      pendingSession,
      [],
      [
        makeAgendaItem({ agendaItemId: publicAgendaId, meetingId, visibility: "meeting" }),
        makeAgendaItem({
          agendaItemId: privateAgendaId,
          meetingId,
          sequence: 1,
          visibility: "private",
        }),
      ],
    );
    await source.service.commitCommand(
      command("meeting.create", 1, {
        meetingId: publicMeetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    const publicPendingSession = makeSession("waiting-for-agent", {
      meetingId: publicMeetingId,
      saveId: "save_safe_origin",
      title: "pending public control",
      createdAtRevision: 2,
      agendaItemIds: [publicControlAgendaId],
      currentAgendaItemId: publicControlAgendaId,
      pendingAgentAction: {
        actionId: publicActionId,
        characterId: "huang-liji",
        responseMode: "speech",
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: FIXTURE_NOW,
      },
    });
    source.meetings.createSession(
      publicPendingSession,
      [],
      [
        makeAgendaItem({
          agendaItemId: publicControlAgendaId,
          meetingId: publicMeetingId,
          visibility: "meeting",
        }),
      ],
    );
    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const payloadPath = join(directory, "pending-history-payload.sqlite");
    await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
    try {
      expect(
        database
          .prepare(
            "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
          )
          .get(meetingId),
      ).toEqual({ status: "in-progress", currentAgenda: null, pending: null });
      const publicPendingRow = database
        .prepare(
          "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
        )
        .get(publicMeetingId) as {
        status: string;
        currentAgenda: string;
        pending: string;
      };
      expect({
        ...publicPendingRow,
        pending: JSON.parse(publicPendingRow.pending),
      }).toEqual({
        status: "waiting-for-agent",
        currentAgenda: publicControlAgendaId,
        pending: publicPendingSession.pendingAgentAction,
      });
      const histories = database
        .prepare(
          "SELECT session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY meeting_version",
        )
        .all(meetingId) as unknown as Array<{ session_json: string }>;
      expect(histories.length).toBeGreaterThan(0);
      for (const history of histories) {
        const session = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(session.pendingAgentAction).toBeUndefined();
        expect(session.currentAgendaItemId).toBeUndefined();
        expect(session.status).toBe("in-progress");
      }
      const publicHistories = database
        .prepare(
          "SELECT session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY meeting_version",
        )
        .all(publicMeetingId) as unknown as Array<{ session_json: string }>;
      expect(publicHistories.length).toBeGreaterThan(0);
      for (const history of publicHistories) {
        const session = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(session.status).toBe("waiting-for-agent");
        expect(session.pendingAgentAction?.actionId).toBe(publicActionId);
      }
    } finally {
      database.close();
    }

    const { system: target, directory: targetDirectory } = await setup(
      "safe-pending-history-target",
    );
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedPrivateSession = target.meetings.getSession(meetingId);
    expect(importedPrivateSession?.status).toBe("in-progress");
    expect(importedPrivateSession?.currentAgendaItemId).toBeUndefined();
    expect(importedPrivateSession?.pendingAgentAction).toBeUndefined();
    expect(target.meetings.getSession(publicMeetingId)).toMatchObject({
      status: "waiting-for-agent",
      currentAgendaItemId: publicControlAgendaId,
      pendingAgentAction: { actionId: publicActionId },
    });
    const importedState = await target.service.loadState(imported.saveId);
    await target.service.commitCommand(
      command("country.adjust-resource", importedState.revision, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "pending reservation rollback probe",
      }),
    );
    await target.service.rollback(imported.saveId, { targetRevision: importedState.revision });
    expect(target.meetings.getSession(meetingId)?.pendingAgentAction).toBeUndefined();

    const reexported = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const secondPayloadPath = join(targetDirectory, "pending-history-second.sqlite");
    await writeFile(secondPayloadPath, parseSavePackage(reexported.bytes).payload);
    const secondDatabase = new DatabaseSync(secondPayloadPath, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      expect(
        secondDatabase
          .prepare(
            "SELECT current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
          )
          .get(meetingId),
      ).toEqual({ currentAgenda: null, pending: null });
    } finally {
      secondDatabase.close();
    }
  });

  it("normalizes a waiting player session when its private current agenda is removed", async () => {
    const meetingId = "pending-player-private-meeting";
    const privateAgendaId = "pending-player-private-agenda";
    const publicMeetingId = "pending-player-public-meeting";
    const publicAgendaId = "pending-player-public-agenda";
    const { system: source, directory } = await setup("safe-pending-player-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "pending player safe share",
      seed: "pending-player-safe-share",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("waiting-for-player", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [privateAgendaId],
        currentAgendaItemId: privateAgendaId,
        pendingPlayerAction: {
          allowedActions: ["address-meeting"],
          reason: "private agenda player decision",
          requestedAtTurn: 0,
        },
      }),
      [],
      [
        makeAgendaItem({
          agendaItemId: privateAgendaId,
          meetingId,
          visibility: "private",
        }),
      ],
    );
    await source.service.commitCommand(
      command("meeting.create", 1, {
        meetingId: publicMeetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    const publicSession = makeSession("waiting-for-player", {
      meetingId: publicMeetingId,
      saveId: "save_safe_origin",
      createdAtRevision: 2,
      agendaItemIds: [publicAgendaId],
      currentAgendaItemId: publicAgendaId,
      pendingPlayerAction: {
        allowedActions: ["address-meeting"],
        reason: "public agenda player decision",
        requestedAtTurn: 0,
      },
    });
    source.meetings.createSession(
      publicSession,
      [],
      [makeAgendaItem({ agendaItemId: publicAgendaId, meetingId: publicMeetingId })],
    );

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const payloadPath = join(directory, "pending-player-payload.sqlite");
    await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
    try {
      const privateHistories = database
        .prepare(
          "SELECT session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY meeting_version",
        )
        .all(meetingId) as unknown as Array<{ session_json: string }>;
      expect(privateHistories.length).toBeGreaterThan(0);
      for (const history of privateHistories) {
        const session = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(session.status).toBe("in-progress");
        expect(session.currentAgendaItemId).toBeUndefined();
        expect(session.pendingPlayerAction).toBeUndefined();
      }
      const publicHistories = database
        .prepare(
          "SELECT session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY meeting_version",
        )
        .all(publicMeetingId) as unknown as Array<{ session_json: string }>;
      expect(publicHistories.length).toBeGreaterThan(0);
      for (const history of publicHistories) {
        const session = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(session.status).toBe("waiting-for-player");
        expect(session.pendingPlayerAction).toEqual(publicSession.pendingPlayerAction);
      }
    } finally {
      database.close();
    }
    const { system: target } = await setup("safe-pending-player-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedPrivateSession = target.meetings.getSession(meetingId);
    expect(importedPrivateSession?.status).toBe("in-progress");
    expect(importedPrivateSession?.currentAgendaItemId).toBeUndefined();
    expect(importedPrivateSession?.pendingPlayerAction).toBeUndefined();
    expect(target.meetings.getSession(publicMeetingId)).toMatchObject({
      status: "waiting-for-player",
      currentAgendaItemId: publicAgendaId,
      pendingPlayerAction: publicSession.pendingPlayerAction,
    });
    expect(await target.service.validateSave(imported.saveId)).toMatchObject({ valid: true });
  });

  it("rejects an unregistered structured ID path that points to a private entity", async () => {
    const meetingId = "unregistered-reference-meeting";
    const publicAgendaId = "unregistered-reference-public-agenda";
    const privateAgendaId = "unregistered-reference-private-agenda";
    const privateOutcomeId = "unregistered-reference-private-outcome";
    const { system: source } = await setup("safe-unregistered-reference-source");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "unregistered safe-share reference",
      seed: "unregistered-safe-share-reference",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [publicAgendaId, privateAgendaId],
        currentAgendaItemId: publicAgendaId,
      }),
      [],
      [
        makeAgendaItem({ agendaItemId: publicAgendaId, meetingId, visibility: "meeting" }),
        makeAgendaItem({
          agendaItemId: privateAgendaId,
          meetingId,
          sequence: 1,
          visibility: "private",
        }),
      ],
    );
    source.meetings.insertOutcomeCandidate(
      outcome(meetingId, privateOutcomeId, privateAgendaId, "private outcome"),
    );
    source.meetings.insertRuling({
      rulingId: "unregistered-reference-public-ruling",
      saveId: "save_safe_origin",
      meetingId,
      agendaItemId: publicAgendaId,
      idempotencyKey: "unregistered-reference-ruling-key",
      requestHash: "d".repeat(64),
      stateRevision: 1,
      result: { unregisteredOutcomeId: privateOutcomeId },
      createdAt: FIXTURE_NOW,
    });

    await expect(
      source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      }),
    ).rejects.toThrow(/未登记的结构化引用/);
  });

  it.each([
    ["private-to-public", "private", "meeting"],
    ["public-to-private", "meeting", "private"],
  ] as const)(
    "resolves agenda visibility on each historical session timeline: %s",
    async (caseName, initialVisibility, latestVisibility) => {
      const meetingId = `timeline-${caseName}-meeting`;
      const agendaItemId = `timeline-${caseName}-agenda`;
      const initialActionId = `timeline-${caseName}-initial-action`;
      const latestActionId = `timeline-${caseName}-latest-action`;
      const { system: source, directory } = await setup(`safe-${caseName}`);
      await source.service.createSave({
        saveId: "save_safe_origin",
        scenarioId: "chongzhen-early",
        title: caseName,
        seed: caseName,
      });
      await source.service.commitCommand(
        command("meeting.create", 0, {
          meetingId,
          meetingType: "imperial-council",
          participantIds: ["huang-liji"],
          chairCharacterId: "emperor",
          visibility: "meeting",
        }),
      );
      const initialSession = makeSession("waiting-for-agent", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: {
          actionId: initialActionId,
          characterId: "huang-liji",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      });
      source.meetings.createSession(
        initialSession,
        [],
        [makeAgendaItem({ agendaItemId, meetingId, visibility: initialVisibility })],
      );
      await source.service.commitCommand(
        command("country.adjust-resource", 1, {
          resource: "treasuryTaels",
          delta: 1,
          reason: "separate safe-share visibility revisions",
        }),
      );
      source.meetings.upsertAgendaItem(
        makeAgendaItem({ agendaItemId, meetingId, visibility: latestVisibility }),
      );
      source.meetings.updateSession(
        {
          ...initialSession,
          meetingVersion: initialSession.meetingVersion + 1,
          pendingAgentAction: {
            ...initialSession.pendingAgentAction!,
            actionId: latestActionId,
          },
        },
        initialSession.meetingVersion,
      );

      const exported = await source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      });
      const payloadPath = join(directory, `${caseName}.sqlite`);
      await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
      const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
      try {
        const histories = database
          .prepare(
            "SELECT state_revision AS revision, session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY state_revision, meeting_version",
          )
          .all(meetingId) as unknown as Array<{ revision: number; session_json: string }>;
        expect(histories).toHaveLength(2);
        const parsed = histories.map((row) =>
          MeetingSessionStateSchema.parse(JSON.parse(row.session_json)),
        );
        const initialIsPrivate = initialVisibility === "private";
        expect(parsed[0]).toMatchObject({
          status: initialIsPrivate ? "in-progress" : "waiting-for-agent",
        });
        expect(parsed[0]?.currentAgendaItemId).toBe(initialIsPrivate ? undefined : agendaItemId);
        expect(parsed[0]?.pendingAgentAction?.actionId).toBe(
          initialIsPrivate ? undefined : initialActionId,
        );
        const latestIsPrivate = latestVisibility === "private";
        expect(parsed[1]).toMatchObject({
          status: latestIsPrivate ? "in-progress" : "waiting-for-agent",
        });
        expect(parsed[1]?.currentAgendaItemId).toBe(latestIsPrivate ? undefined : agendaItemId);
        expect(parsed[1]?.pendingAgentAction?.actionId).toBe(
          latestIsPrivate ? undefined : latestActionId,
        );
        const agendaVersions = database
          .prepare(
            "SELECT state_revision AS revision, entity_json FROM meeting_agenda_item_versions WHERE meeting_id = ? ORDER BY state_revision, version_id",
          )
          .all(meetingId) as unknown as Array<{ revision: number; entity_json: string }>;
        expect(agendaVersions.map((row) => JSON.parse(row.entity_json).visibility)).toEqual([
          "meeting",
        ]);
      } finally {
        database.close();
      }
    },
  );

  it("fails closed for a pending session whose current agenda identity is missing", async () => {
    const meetingId = "missing-agenda-meeting";
    const agendaItemId = "missing-agenda-identity";
    const actionId = "missing-agenda-action";
    const { system: source, directory } = await setup("safe-missing-agenda");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "missing agenda",
      seed: "missing-agenda",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("waiting-for-agent", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: {
          actionId,
          characterId: "huang-liji",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      }),
      [],
      [],
    );

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const payloadPath = join(directory, "missing-agenda.sqlite");
    await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
    try {
      const current = database
        .prepare(
          "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending, agenda_item_ids_json AS agendaItems FROM meeting_sessions WHERE meeting_id = ?",
        )
        .get(meetingId);
      expect(current).toEqual({
        status: "in-progress",
        currentAgenda: null,
        pending: null,
        agendaItems: "[]",
      });
      const histories = database
        .prepare("SELECT session_json FROM meeting_session_versions WHERE meeting_id = ?")
        .all(meetingId) as unknown as Array<{ session_json: string }>;
      expect(histories).toHaveLength(1);
      const history = MeetingSessionStateSchema.parse(JSON.parse(histories[0]!.session_json));
      expect(history).toMatchObject({ status: "in-progress" });
      expect(history.agendaItemIds).toEqual([]);
      expect(history.currentAgendaItemId).toBeUndefined();
      expect(history.pendingAgentAction).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it.each(["deleted", "ambiguous"] as const)(
    "fails closed for a pending session whose current agenda projection is %s",
    async (caseName) => {
      const meetingId = `${caseName}-agenda-meeting`;
      const agendaItemId = `${caseName}-agenda-identity`;
      const actionId = `${caseName}-agenda-action`;
      const { system: source, directory } = await setup(`safe-${caseName}-agenda`);
      await source.service.createSave({
        saveId: "save_safe_origin",
        scenarioId: "chongzhen-early",
        title: `${caseName} agenda`,
        seed: `${caseName}-agenda`,
      });
      await source.service.commitCommand(
        command("meeting.create", 0, {
          meetingId,
          meetingType: "imperial-council",
          participantIds: ["huang-liji"],
          chairCharacterId: "emperor",
          visibility: "meeting",
        }),
      );
      const session = makeSession("waiting-for-agent", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: {
          actionId,
          characterId: "huang-liji",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      });
      const agenda = makeAgendaItem({ agendaItemId, meetingId, visibility: "meeting" });
      source.meetings.createSession(session, [], [agenda]);
      if (caseName === "deleted") {
        source.database
          .prepare("DELETE FROM meeting_agenda_items WHERE agenda_item_id = ? AND meeting_id = ?")
          .run(agendaItemId, meetingId);
      } else {
        source.meetings.upsertAgendaItem(agenda);
      }

      const exported = await source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      });
      const payloadPath = join(directory, `${caseName}-agenda.sqlite`);
      await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
      const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
      try {
        expect(
          database
            .prepare(
              "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
            )
            .get(meetingId),
        ).toEqual({ status: "in-progress", currentAgenda: null, pending: null });
        const history = database
          .prepare("SELECT session_json FROM meeting_session_versions WHERE meeting_id = ?")
          .get(meetingId) as { session_json: string };
        const parsedHistory = MeetingSessionStateSchema.parse(JSON.parse(history.session_json));
        expect(parsedHistory).toMatchObject({ status: "in-progress" });
        expect(parsedHistory.currentAgendaItemId).toBeUndefined();
        expect(parsedHistory.pendingAgentAction).toBeUndefined();
      } finally {
        database.close();
      }

      const { system: target } = await setup(`safe-${caseName}-agenda-target`);
      const imported = await target.service.importSave({ bytes: exported.bytes });
      expect(target.meetings.getSession(meetingId)).toMatchObject({ status: "in-progress" });
      expect(target.meetings.getSession(meetingId)?.currentAgendaItemId).toBeUndefined();
      expect(target.meetings.getSession(meetingId)?.pendingAgentAction).toBeUndefined();
      const second = await target.service.exportSave(imported.saveId, {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      });
      expect(second.bytes.byteLength).toBeGreaterThan(0);
    },
  );

  it("fails closed when the current meeting projection is missing even if its agenda row is public", async () => {
    const meetingId = "missing-meeting-projection";
    const agendaItemId = "missing-meeting-public-agenda";
    const { system: source, directory } = await setup("safe-missing-meeting");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "missing meeting projection",
      seed: "missing-meeting-projection",
    });
    source.meetings.createSession(
      makeSession("waiting-for-player", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 0,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingPlayerAction: {
          allowedActions: ["address-meeting"],
          reason: "orphan meeting projection",
          requestedAtTurn: 0,
        },
      }),
      [],
      [makeAgendaItem({ meetingId, agendaItemId, visibility: "meeting" })],
    );

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const path = join(directory, "missing-meeting.sqlite");
    await writeFile(path, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      expect(
        database
          .prepare(
            "SELECT status, current_agenda_item_id AS currentAgenda, pending_player_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
          )
          .get(meetingId),
      ).toEqual({ status: "in-progress", currentAgenda: null, pending: null });
    } finally {
      database.close();
    }
  });

  it("keeps abandoned history on its own ancestry while current stays fail-closed across rollbacks", async () => {
    const meetingId = "rollback-ancestry-meeting";
    const agendaItemId = "rollback-ancestry-agenda";
    const branchActionId = "rollback-ancestry-action";
    const { system: source, directory } = await setup("safe-rollback-ancestry");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "rollback ancestry",
      seed: "rollback-ancestry",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    const baseSession = makeSession("in-progress", {
      meetingId,
      saveId: "save_safe_origin",
      createdAtRevision: 1,
      agendaItemIds: [],
    });
    source.meetings.createSession(baseSession, [], []);
    await source.service.commitCommand(
      command("country.adjust-resource", 1, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "abandoned agenda branch",
      }),
    );
    source.meetings.upsertAgendaItem(
      makeAgendaItem({ meetingId, agendaItemId, visibility: "meeting" }),
    );
    source.meetings.updateSession(
      {
        ...baseSession,
        meetingVersion: baseSession.meetingVersion + 1,
        status: "waiting-for-agent",
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: {
          actionId: branchActionId,
          characterId: "huang-liji",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      },
      baseSession.meetingVersion,
    );
    await source.service.rollback("save_safe_origin", { targetRevision: 1 });
    await source.service.commitCommand(
      command("country.adjust-resource", 3, {
        resource: "treasuryTaels",
        delta: 1,
        reason: "second branch before rollback",
      }),
    );
    await source.service.rollback("save_safe_origin", { targetRevision: 1 });

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const path = join(directory, "rollback-ancestry.sqlite");
    await writeFile(path, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      expect(
        database
          .prepare(
            "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
          )
          .get(meetingId),
      ).toEqual({ status: "in-progress", currentAgenda: null, pending: null });
      const histories = database
        .prepare(
          "SELECT state_revision AS revision, session_json FROM meeting_session_versions WHERE meeting_id = ? ORDER BY state_revision, meeting_version",
        )
        .all(meetingId) as unknown as Array<{ revision: number; session_json: string }>;
      const branch = histories.find((row) => row.revision === 2);
      expect(branch).toBeDefined();
      expect(MeetingSessionStateSchema.parse(JSON.parse(branch!.session_json))).toMatchObject({
        status: "waiting-for-agent",
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: { actionId: branchActionId },
      });
    } finally {
      database.close();
    }

    const { system: target } = await setup("safe-rollback-ancestry-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    expect(target.meetings.getSession(meetingId)).toMatchObject({ status: "in-progress" });
    expect(target.meetings.getSession(meetingId)?.pendingAgentAction).toBeUndefined();
    const second = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    expect(second.bytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects unregistered structured ID paths even for public and unknown values", async () => {
    const meetingId = "unregistered-public-meeting";
    const agendaItemId = "unregistered-public-agenda";
    const outcomeId = "unregistered-public-outcome";
    const { system: source } = await setup("safe-unregistered-public");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "unregistered public references",
      seed: "unregistered-public-references",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
      }),
      [],
      [makeAgendaItem({ agendaItemId, meetingId, visibility: "meeting" })],
    );
    source.meetings.insertOutcomeCandidate(outcome(meetingId, outcomeId, agendaItemId, "public"));
    source.meetings.insertRuling({
      rulingId: "unregistered-public-ruling",
      saveId: "save_safe_origin",
      meetingId,
      agendaItemId,
      idempotencyKey: "unregistered-public-ruling-key",
      requestHash: "e".repeat(64),
      stateRevision: 1,
      result: { futureOutcomeId: outcomeId },
      createdAt: FIXTURE_NOW,
    });

    await expect(
      source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      }),
    ).rejects.toThrow(/未登记的结构化引用/);

    source.meetings.insertOutcomeCandidate(
      outcome(meetingId, agendaItemId, agendaItemId, "cross-type public collision"),
    );
    source.database
      .prepare("UPDATE meeting_rulings SET result_json = ? WHERE ruling_id = ?")
      .run(stableStringify({ futureSharedId: agendaItemId }), "unregistered-public-ruling");
    await expect(
      source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      }),
    ).rejects.toThrow(/未登记的结构化引用/);

    source.database
      .prepare("UPDATE meeting_rulings SET result_json = ? WHERE ruling_id = ?")
      .run(stableStringify({ futureLinkId: "unknown-reference" }), "unregistered-public-ruling");
    await expect(
      source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      }),
    ).rejects.toThrow(/未登记的结构化引用/);

    source.database.prepare("UPDATE meeting_rulings SET result_json = ? WHERE ruling_id = ?").run(
      stableStringify({
        summary: `ordinary text keeps futureLinkId, unknown-reference and ${outcomeId}`,
      }),
      "unregistered-public-ruling",
    );
    const textControl = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    expect(textControl.bytes.byteLength).toBeGreaterThan(0);
  });

  it("fails closed when an agenda version payload disagrees with its persisted relationship", async () => {
    const meetingId = "relation-mismatch-meeting";
    const agendaItemId = "relation-mismatch-agenda";
    const actionId = "relation-mismatch-action";
    const { system: source, directory } = await setup("safe-relation-mismatch");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "relation mismatch",
      seed: "relation-mismatch",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("waiting-for-agent", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: {
          actionId,
          characterId: "huang-liji",
          responseMode: "speech",
          addressedCharacterIds: [],
          reservedAtTurn: 0,
          reservedAt: FIXTURE_NOW,
        },
      }),
      [],
      [makeAgendaItem({ agendaItemId, meetingId, visibility: "meeting" })],
    );
    source.database
      .prepare(
        "UPDATE meeting_agenda_item_versions SET entity_json = ? WHERE meeting_id = ? AND agenda_item_id = ?",
      )
      .run(
        stableStringify(
          makeAgendaItem({
            agendaItemId: "other-agenda",
            meetingId: "other-meeting",
            visibility: "meeting",
          }),
        ),
        meetingId,
        agendaItemId,
      );

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const payloadPath = join(directory, "relation-mismatch.sqlite");
    await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
    try {
      expect(
        database
          .prepare(
            "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending, agenda_item_ids_json AS agendaItems FROM meeting_sessions WHERE meeting_id = ?",
          )
          .get(meetingId),
      ).toEqual({
        status: "in-progress",
        currentAgenda: null,
        pending: null,
        agendaItems: "[]",
      });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS total FROM meeting_agenda_item_versions WHERE meeting_id = ? AND agenda_item_id = ?",
          )
          .get(meetingId, agendaItemId),
      ).toEqual({ total: 0 });
    } finally {
      database.close();
    }

    const { system: target } = await setup("safe-relation-mismatch-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    expect(target.meetings.getSession(meetingId)).toMatchObject({
      status: "in-progress",
      agendaItemIds: [],
    });
    expect(target.meetings.getSession(meetingId)?.currentAgendaItemId).toBeUndefined();
    expect(target.meetings.getSession(meetingId)?.pendingAgentAction).toBeUndefined();
    const second = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    expect(second.bytes.byteLength).toBeGreaterThan(0);
  });

  it("removes registered typed unknown references while retaining typed public controls", async () => {
    const meetingId = "typed-unknown-meeting";
    const agendaItemId = "typed-unknown-agenda";
    const publicOutcomeId = "typed-known-public-outcome";
    const unknownOutcomeId = "typed-unknown-outcome";
    const rulingId = "typed-unknown-ruling";
    const { system: source, directory } = await setup("safe-typed-unknown");
    await source.service.createSave({
      saveId: "save_safe_origin",
      scenarioId: "chongzhen-early",
      title: "typed unknown",
      seed: "typed-unknown",
    });
    await source.service.commitCommand(
      command("meeting.create", 0, {
        meetingId,
        meetingType: "imperial-council",
        participantIds: ["huang-liji"],
        chairCharacterId: "emperor",
        visibility: "meeting",
      }),
    );
    source.meetings.createSession(
      makeSession("scheduled", {
        meetingId,
        saveId: "save_safe_origin",
        createdAtRevision: 1,
        agendaItemIds: [agendaItemId],
        currentAgendaItemId: agendaItemId,
      }),
      [],
      [makeAgendaItem({ agendaItemId, meetingId, visibility: "meeting" })],
    );
    source.meetings.insertOutcomeCandidate(
      outcome(meetingId, publicOutcomeId, agendaItemId, "typed public control"),
    );
    const sourceResult = {
      publicReference: { outcomeCandidateId: publicOutcomeId },
      unknownReference: { outcomeCandidateId: unknownOutcomeId },
      selectedOutcomeCandidateIds: [publicOutcomeId, unknownOutcomeId],
    };
    source.meetings.insertRuling({
      rulingId,
      saveId: "save_safe_origin",
      meetingId,
      agendaItemId,
      idempotencyKey: "typed-unknown-ruling-key",
      requestHash: "f".repeat(64),
      stateRevision: 1,
      result: sourceResult,
      createdAt: FIXTURE_NOW,
    });

    const exported = await source.service.exportSave("save_safe_origin", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const payloadPath = join(directory, "typed-unknown.sqlite");
    await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
    const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
    try {
      const row = database
        .prepare("SELECT result_json FROM meeting_rulings WHERE ruling_id = ?")
        .get(rulingId) as { result_json: string };
      expect(JSON.parse(row.result_json)).toEqual({
        publicReference: { outcomeCandidateId: publicOutcomeId },
        unknownReference: {},
        selectedOutcomeCandidateIds: [publicOutcomeId],
      });
    } finally {
      database.close();
    }
    expect(
      JSON.parse(
        String(
          (
            source.database
              .prepare("SELECT result_json FROM meeting_rulings WHERE ruling_id = ?")
              .get(rulingId) as { result_json: string }
          ).result_json,
        ),
      ),
    ).toEqual(sourceResult);

    const { system: target, directory: targetDirectory } = await setup("safe-typed-unknown-target");
    const imported = await target.service.importSave({ bytes: exported.bytes });
    const importedRuling = target.database
      .prepare(
        "SELECT result_json FROM meeting_rulings WHERE save_id = ? AND meeting_id = ? AND idempotency_key = ?",
      )
      .get(imported.saveId, meetingId, "typed-unknown-ruling-key") as
      { result_json: string } | undefined;
    expect(JSON.parse(importedRuling!.result_json)).toEqual({
      publicReference: { outcomeCandidateId: publicOutcomeId },
      unknownReference: {},
      selectedOutcomeCandidateIds: [publicOutcomeId],
    });
    const second = await target.service.exportSave(imported.saveId, {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const secondPath = join(targetDirectory, "typed-unknown-second.sqlite");
    await writeFile(secondPath, parseSavePackage(second.bytes).payload);
    const secondDatabase = new DatabaseSync(secondPath, { readOnly: true, allowExtension: false });
    try {
      expect(dumpAllDatabaseValues(secondDatabase)).not.toContain(unknownOutcomeId);
    } finally {
      secondDatabase.close();
    }
  });

  it.each([
    {
      caseName: "mixed known and unknown characters",
      participantIds: ["huang-liji", "unknown-character", "wei-zhongxian"],
      expectedParticipantIds: ["huang-liji", "wei-zhongxian"],
    },
    {
      caseName: "unknown character only",
      participantIds: ["unknown-character"],
      expectedParticipantIds: [],
    },
    {
      caseName: "known public characters only",
      participantIds: ["wei-zhongxian", "huang-liji"],
      expectedParticipantIds: ["wei-zhongxian", "huang-liji"],
    },
    {
      caseName: "public character colliding with a private event",
      participantIds: ["huang-liji"],
      expectedParticipantIds: ["huang-liji"],
      privateEventIds: ["huang-liji"],
    },
    {
      caseName: "unknown character colliding with a public event",
      participantIds: ["shared-public-event"],
      expectedParticipantIds: [],
      publicEventIds: ["shared-public-event"],
    },
  ])(
    "filters GameState meeting participantIds by the character registry: $caseName",
    async ({
      caseName,
      participantIds,
      expectedParticipantIds,
      publicEventIds,
      privateEventIds,
    }) => {
      const meetingId = `participant-${caseName.replaceAll(" ", "-")}`;
      const { system: source, directory } = await setup(
        `safe-participant-${caseName.replaceAll(" ", "-")}`,
      );
      await source.service.createSave({
        saveId: "save_safe_origin",
        scenarioId: "chongzhen-early",
        title: `participant ${caseName}`,
        seed: `participant-${caseName}`,
      });
      await source.service.commitCommand(
        command("meeting.create", 0, {
          meetingId,
          meetingType: "imperial-council",
          participantIds: ["huang-liji", "wei-zhongxian"],
          chairCharacterId: "emperor",
          visibility: "meeting",
        }),
      );
      await installMeetingParticipantFixture(source, {
        meetingId,
        participantIds,
        ...(publicEventIds === undefined ? {} : { publicEventIds }),
        ...(privateEventIds === undefined ? {} : { privateEventIds }),
      });

      expect(SAFE_SHARE_REFERENCE_CONTRACT.array.participantIds).toBe("characterIds");
      const originalState = await source.service.loadState("save_safe_origin");
      const originalDatabase = dumpAllDatabaseValues(source.database);
      expect(originalState.meetings[meetingId]?.participantIds).toEqual(participantIds);
      expect(originalState.characters["huang-liji"]).toBeDefined();
      expect(originalState.characters["wei-zhongxian"]).toBeDefined();
      expect(originalState.characters["unknown-character"]).toBeUndefined();
      expect(originalState.characters["shared-public-event"]).toBeUndefined();

      const exported = await source.service.exportSave("save_safe_origin", {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      });
      expect(exported.bytes.byteLength).toBeGreaterThan(0);
      const payloadPath = join(directory, `participant-${caseName}.sqlite`);
      await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
      const payloadDatabase = new DatabaseSync(payloadPath, {
        readOnly: true,
        allowExtension: false,
      });
      try {
        const snapshot = payloadDatabase
          .prepare("SELECT state_json FROM save_snapshots ORDER BY revision DESC LIMIT 1")
          .get() as { state_json: string };
        const sanitizedState = GameStateSchema.parse(JSON.parse(snapshot.state_json));
        expect(sanitizedState.meetings[meetingId]?.participantIds).toEqual(expectedParticipantIds);
      } finally {
        payloadDatabase.close();
      }

      const targetDirectory = await mkdtemp(join(tmpdir(), `mandate-participant-target-`));
      const targetPath = join(targetDirectory, "save.sqlite");
      let target: SaveSystem | undefined = createSaveSystem({
        databasePath: targetPath,
        scenarioLoader: createScenarioLoader(),
        clock: new FixedClock(FIXTURE_NOW),
      });
      cleanup.push(async () => {
        target?.close();
        await rm(targetDirectory, { recursive: true, force: true });
      });
      const imported = await target.service.importSave({ bytes: exported.bytes });
      target.close();
      target = createSaveSystem({
        databasePath: targetPath,
        scenarioLoader: createScenarioLoader(),
        clock: new FixedClock(FIXTURE_NOW),
      });
      expect(
        (await target.service.loadState(imported.saveId)).meetings[meetingId]?.participantIds,
      ).toEqual(expectedParticipantIds);

      const second = await target.service.exportSave(imported.saveId, {
        includeSourceMetadata: false,
        safeShareMode: "safe_share",
      });
      const secondPath = join(targetDirectory, `participant-${caseName}-second.sqlite`);
      await writeFile(secondPath, parseSavePackage(second.bytes).payload);
      const secondDatabase = new DatabaseSync(secondPath, {
        readOnly: true,
        allowExtension: false,
      });
      try {
        const snapshot = secondDatabase
          .prepare("SELECT state_json FROM save_snapshots ORDER BY revision DESC LIMIT 1")
          .get() as { state_json: string };
        const secondState = GameStateSchema.parse(JSON.parse(snapshot.state_json));
        expect(secondState.meetings[meetingId]?.participantIds).toEqual(expectedParticipantIds);
      } finally {
        secondDatabase.close();
      }

      expect(await source.service.loadState("save_safe_origin")).toEqual(originalState);
      expect(dumpAllDatabaseValues(source.database)).toBe(originalDatabase);
    },
  );

  it("scopes Reference Contract registration by persisted object and JSON path", () => {
    const rulingOutcomeContext = {
      table: "meeting_rulings",
      column: "result_json",
      path: "$.outcomeCandidateId",
    };
    const unrelatedOutcomeContext = {
      table: "saves",
      column: "metadata_json",
      path: "$.outcomeCandidateId",
    };
    const sessionSaveContext = {
      table: "meeting_session_versions",
      column: "session_json",
      path: "$.saveId",
    };
    const unrelatedSaveContext = {
      table: "meeting_rulings",
      column: "result_json",
      path: "$.saveId",
    };
    expect(isRegisteredSafeShareStructuredIdField("outcomeCandidateId", rulingOutcomeContext)).toBe(
      true,
    );
    expect(
      isRegisteredSafeShareStructuredIdField("outcomeCandidateId", unrelatedOutcomeContext),
    ).toBe(false);
    expect(isRegisteredSafeShareStructuredIdField("saveId", sessionSaveContext)).toBe(true);
    expect(isRegisteredSafeShareStructuredIdField("saveId", unrelatedSaveContext)).toBe(false);
  });

  it("keeps every current structured ID field in the executable Reference Contract", () => {
    const knownStructuredIdFields = [
      "acceptedOutcomeCandidateIds",
      "actionId",
      "actorId",
      "addressedCharacterIds",
      "agendaItemId",
      "agendaItemIds",
      "allowedOfficeIds",
      "audienceCharacterIds",
      "authorCharacterId",
      "challengedCharacterIds",
      "characterId",
      "chairCharacterId",
      "commandId",
      "contextRegionId",
      "coreCharacterIds",
      "currentAgendaItemId",
      "currentMeetingId",
      "currentOfficeId",
      "currentSpeakerId",
      "deferredAgendaItemIds",
      "dynastyId",
      "entityId",
      "eventId",
      "firedEventIds",
      "fromCharacterId",
      "frontRegionIds",
      "holderCharacterId",
      "initialOfficeId",
      "leakEventCandidateIds",
      "lineageId",
      "locationRegionId",
      "meetingId",
      "memoryId",
      "memoryIds",
      "minutesId",
      "modifierId",
      "nextAgendaItemId",
      "officeId",
      "opponentIds",
      "outcomeCandidateId",
      "outcomeCandidateIds",
      "participantIds",
      "pendingEventIds",
      "policyId",
      "policyIds",
      "policyTemplateIds",
      "potentialAudienceIds",
      "processedEventIds",
      "proposerId",
      "proposerIds",
      "queuedEventIds",
      "regionId",
      "regionIds",
      "relatedCharacterId",
      "relatedCharacterIds",
      "relatedEntityIds",
      "relatedPolicyId",
      "requiredOfficeIds",
      "responsibleCharacterIds",
      "rulingId",
      "rulerCharacterId",
      "saveId",
      "scenarioId",
      "selectedOutcomeCandidateIds",
      "sessionId",
      "snapshotId",
      "sourceCommandId",
      "sourceId",
      "sourceIds",
      "sourceMeetingId",
      "sourceTurnIds",
      "speakerId",
      "summarizedMemoryIds",
      "supporterIds",
      "targetCharacterId",
      "targetEntityIds",
      "targetRegionIds",
      "templateId",
      "toCharacterId",
      "topicIds",
      "transactionId",
      "transcriptMemoryId",
      "turnId",
    ];
    expect(
      knownStructuredIdFields.filter((field) => !isRegisteredSafeShareStructuredIdField(field)),
    ).toEqual([]);
    expect(SAFE_SHARE_REFERENCE_CONTRACT.resolution).toEqual({
      uniqueTarget: "required",
      ambiguity: "remove",
      unknown: "remove",
      missingTarget: "remove",
    });
    expect(SAFE_SHARE_REFERENCE_CONTRACT.sqliteRootArrays).toHaveProperty(
      "meeting_sessions.agenda_item_ids_json",
    );
    expect(SAFE_SHARE_REFERENCE_CONTRACT.sqliteDirect).toContainEqual({
      table: "meeting_sessions",
      column: "current_agenda_item_id",
      entitySet: "agendaIds",
    });
    expect(isRegisteredSafeShareStructuredIdField("futureUnknownId")).toBe(false);
  });

  it("guards the real Stage A test against replacement with a hand-written pending fixture", async () => {
    const source = await readFile(new URL(import.meta.url), "utf8");
    for (const productionEvidence of [
      "create" + "CharacterMockProvider",
      "await provider" + "Started;",
      "/st" + "ep`",
      "response" + "Promise",
      "listTurns" + "(meetingId)",
    ]) {
      expect(source).toContain(productionEvidence);
    }
  });

  it.each([
    ["private-agenda", "imperial-council", "private", "normalized"],
    ["private-meeting", "secret-council", "meeting", "removed"],
    ["public-control", "imperial-council", "meeting", "preserved"],
  ] as const)(
    "sanitizes a real Stage A reservation before the provider writes a turn: %s",
    async (caseName, meetingType, agendaVisibility, expectedExport) => {
      const meetingId = `stage-a-${caseName}-meeting`;
      const agendaItemId = `stage-a-${caseName}-agenda`;
      const actionId = `stage-a-${caseName}-action`;
      const { system: source, directory } = await setup(`safe-stage-a-${caseName}`);
      const base = createCharacterMockProvider(
        { defaultStance: "support" },
        { "huang-liji": "黄立极" },
      );
      let releaseProvider!: () => void;
      let signalStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const provider: LLMProvider = {
        name: base.name,
        async generate(messages, options) {
          signalStarted();
          await providerGate;
          return base.generate(messages, options);
        },
        generateStructured: (messages, options) => base.generateStructured(messages, options),
      };
      const app = await buildApp({
        config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
        provider,
        saveSystem: source,
        logger: false,
      });
      cleanup.push(() => app.close());
      await app.inject({
        method: "POST",
        url: "/api/saves",
        payload: {
          saveId: "save_safe_origin",
          scenarioId: "chongzhen-early",
          title: "stage a safe share",
          seed: "stage-a-safe-share",
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/saves/save_safe_origin/meetings",
        payload: {
          meetingId,
          type: meetingType,
          title: "stage a",
          purpose: "stage a crash-window regression",
          participantIds: ["huang-liji"],
          expectedRevision: 0,
        },
      });
      await app.inject({
        method: "POST",
        url: `/api/saves/save_safe_origin/meetings/${meetingId}/agenda`,
        payload: {
          agendaItemId,
          title: "private stage a",
          description: "private stage a",
          visibility: agendaVisibility,
        },
      });
      await app.inject({
        method: "POST",
        url: `/api/saves/save_safe_origin/meetings/${meetingId}/start`,
        payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
      });
      let session = (
        await app.inject({
          method: "GET",
          url: `/api/saves/save_safe_origin/meetings/${meetingId}`,
        })
      ).json().data.session;
      const advanced = await app.inject({
        method: "POST",
        url: `/api/saves/save_safe_origin/meetings/${meetingId}/step`,
        payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
      });
      session = advanced.json().data.session;
      const responsePromise = app.inject({
        method: "POST",
        url: `/api/saves/save_safe_origin/meetings/${meetingId}/step`,
        payload: {
          expectedRevision: 2,
          expectedMeetingVersion: session.meetingVersion,
          idempotencyKey: actionId,
        },
      });
      await providerStarted;
      expect(source.meetings.getSession(meetingId)).toMatchObject({
        status: "waiting-for-agent",
        currentAgendaItemId: agendaItemId,
        pendingAgentAction: { actionId },
      });
      expect(
        source.meetings.listTurns(meetingId).turns.some((turn) => turn.actionId === actionId),
      ).toBe(false);
      try {
        const exported = await source.service.exportSave("save_safe_origin", {
          includeSourceMetadata: false,
          safeShareMode: "safe_share",
        });
        const payloadPath = join(directory, "stage-a.sqlite");
        await writeFile(payloadPath, parseSavePackage(exported.bytes).payload);
        const database = new DatabaseSync(payloadPath, { readOnly: true, allowExtension: false });
        try {
          const current = database
            .prepare(
              "SELECT status, current_agenda_item_id AS currentAgenda, pending_agent_action_json AS pending FROM meeting_sessions WHERE meeting_id = ?",
            )
            .get(meetingId);
          if (expectedExport === "removed") {
            expect(current).toBeUndefined();
          } else if (expectedExport === "normalized") {
            expect(current).toEqual({ status: "in-progress", currentAgenda: null, pending: null });
          } else {
            expect(current).toMatchObject({
              status: "waiting-for-agent",
              currentAgenda: agendaItemId,
            });
            expect(JSON.parse((current as { pending: string }).pending)).toMatchObject({
              actionId,
            });
          }
        } finally {
          database.close();
        }
      } finally {
        releaseProvider();
        await responsePromise;
      }
    },
  );
});
