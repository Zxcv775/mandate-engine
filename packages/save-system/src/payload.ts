import {
  GameStateSchema,
  MeetingAgendaItemSchema,
  MeetingOutcomeCandidateSchema,
  MeetingSessionStateSchema,
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

function confidentialMeetingIds(database: DatabaseSync, saveId: string): Set<string> {
  try {
    const rows = database
      .prepare(
        "SELECT meeting_id FROM meeting_sessions WHERE save_id = ? AND (visibility = 'sealed' OR type = 'secret-council')",
      )
      .all(saveId) as unknown as Array<{ meeting_id: string }>;
    return new Set(rows.map((row) => row.meeting_id));
  } catch {
    // Phase 2 旧库尚无会议表。
    return new Set();
  }
}

interface SafeShareForbiddenEntities {
  readonly projectedMeetingIds: Set<string>;
  readonly meetingIds: Set<string>;
  readonly sessionIds: Set<string>;
  readonly agendaIds: Set<string>;
  readonly turnIds: Set<string>;
  readonly outcomeIds: Set<string>;
  readonly rulingIds: Set<string>;
  readonly minutesIds: Set<string>;
  readonly memoryIds: Set<string>;
  readonly conversationTurnIds: Set<string>;
  readonly actionIds: Set<string>;
  readonly eventIds: Set<string>;
  readonly historicalSourceIds: Set<string>;
  readonly characterIds: Set<string>;
  readonly officeIds: Set<string>;
  readonly policyIds: Set<string>;
  readonly policyTemplateIds: Set<string>;
  readonly regionIds: Set<string>;
  readonly modifierIds: Set<string>;
  readonly scenarioIds: Set<string>;
  readonly dynastyIds: Set<string>;
  readonly known: SafeShareEntitySets;
}

type SafeShareEntitySets = Omit<SafeShareForbiddenEntities, "known" | "projectedMeetingIds">;

function createEntitySets(): SafeShareEntitySets {
  return {
    meetingIds: new Set(),
    sessionIds: new Set(),
    agendaIds: new Set(),
    turnIds: new Set(),
    outcomeIds: new Set(),
    rulingIds: new Set(),
    minutesIds: new Set(),
    memoryIds: new Set(),
    conversationTurnIds: new Set(),
    actionIds: new Set(),
    eventIds: new Set(),
    historicalSourceIds: new Set(),
    characterIds: new Set(),
    officeIds: new Set(),
    policyIds: new Set(),
    policyTemplateIds: new Set(),
    regionIds: new Set(),
    modifierIds: new Set(),
    scenarioIds: new Set(),
    dynastyIds: new Set(),
  };
}

function createForbiddenEntities(): SafeShareForbiddenEntities {
  return { ...createEntitySets(), projectedMeetingIds: new Set(), known: createEntitySets() };
}

function addEntityId(typeSet: Set<string>, id: unknown): void {
  if (typeof id === "string" && id.length > 0) typeSet.add(id);
}

function addForbiddenId(typeSet: Set<string>, id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0 || typeSet.has(id)) return false;
  typeSet.add(id);
  return true;
}

const SOURCE_REFERENCE_ENTITY_SETS: ReadonlyArray<keyof SafeShareEntitySets> = [
  "historicalSourceIds",
  "meetingIds",
  "agendaIds",
  "turnIds",
  "outcomeIds",
  "rulingIds",
  "minutesIds",
  "memoryIds",
  "conversationTurnIds",
  "actionIds",
  "eventIds",
  "characterIds",
  "officeIds",
  "policyIds",
  "policyTemplateIds",
  "regionIds",
  "modifierIds",
];

const RELATED_REFERENCE_ENTITY_SETS: ReadonlyArray<keyof SafeShareEntitySets> = [
  "meetingIds",
  "agendaIds",
  "turnIds",
  "outcomeIds",
  "rulingIds",
  "minutesIds",
  "memoryIds",
  "conversationTurnIds",
  "actionIds",
  "eventIds",
  "characterIds",
  "officeIds",
  "policyIds",
  "policyTemplateIds",
  "regionIds",
  "modifierIds",
  "scenarioIds",
  "dynastyIds",
];

type PolymorphicReferenceKind = "source" | "related";

/** 分享副本仅保留能在字段允许类型中唯一解析、且该身份公开的无类型引用。 */
function isUnsafePolymorphicReference(
  entities: SafeShareForbiddenEntities,
  id: string,
  kind: PolymorphicReferenceKind,
): boolean {
  const allowedSets =
    kind === "source" ? SOURCE_REFERENCE_ENTITY_SETS : RELATED_REFERENCE_ENTITY_SETS;
  let identityCount = 0;
  let hasForbiddenIdentity = false;
  for (const entitySet of allowedSets) {
    if (!entities.known[entitySet].has(id)) continue;
    identityCount += 1;
    hasForbiddenIdentity ||= entities[entitySet].has(id);
  }
  return identityCount !== 1 || hasForbiddenIdentity;
}

function filterPolymorphicIds(
  ids: string[],
  entities: SafeShareForbiddenEntities,
  kind: PolymorphicReferenceKind,
): string[] {
  return ids.filter((id) => !isUnsafePolymorphicReference(entities, id, kind));
}

function readRows<T>(database: DatabaseSync, sql: string, saveId: string): T[] {
  try {
    return database.prepare(sql).all(saveId) as unknown as T[];
  } catch {
    // 兼容尚无对应 Phase 3/4 表的旧库。
    return [];
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function jsonIdArrayContains(value: unknown, forbiddenIds: ReadonlySet<string>): boolean {
  const parsed = parseJson(value);
  return (
    Array.isArray(parsed) &&
    parsed.some((item) => typeof item === "string" && forbiddenIds.has(item))
  );
}

type RootArrayReference =
  | { readonly entitySet: keyof SafeShareEntitySets }
  | { readonly polymorphic: PolymorphicReferenceKind };

interface DirectReference {
  readonly table: string;
  readonly column: string;
  readonly entitySet: keyof SafeShareEntitySets;
}

const SQLITE_ROOT_ARRAY_REFERENCE_CONTRACT: Readonly<Record<string, RootArrayReference>> = {
  "character_memories.related_entity_ids_json": { polymorphic: "related" },
  "meeting_sessions.agenda_item_ids_json": { entitySet: "agendaIds" },
  "meeting_sessions.outcome_candidate_ids_json": { entitySet: "outcomeIds" },
  "meeting_agenda_items.related_entity_ids_json": { polymorphic: "related" },
  "meeting_turns.source_turn_ids_json": { entitySet: "turnIds" },
  "meeting_outcome_candidates.source_turn_ids_json": { entitySet: "turnIds" },
  "meeting_minutes.accepted_outcome_candidate_ids_json": { entitySet: "outcomeIds" },
  "meeting_minutes.deferred_agenda_item_ids_json": { entitySet: "agendaIds" },
  "state_change_log.source_ids_json": { polymorphic: "source" },
};

const SQLITE_DIRECT_REFERENCE_CONTRACT: ReadonlyArray<DirectReference> = [
  { table: "meeting_sessions", column: "meeting_id", entitySet: "sessionIds" },
  { table: "meeting_sessions", column: "current_agenda_item_id", entitySet: "agendaIds" },
  { table: "meeting_agenda_items", column: "agenda_item_id", entitySet: "agendaIds" },
  { table: "meeting_agenda_items", column: "meeting_id", entitySet: "meetingIds" },
  { table: "meeting_turns", column: "turn_id", entitySet: "turnIds" },
  { table: "meeting_turns", column: "meeting_id", entitySet: "meetingIds" },
  { table: "meeting_turns", column: "agenda_item_id", entitySet: "agendaIds" },
  { table: "meeting_turns", column: "action_id", entitySet: "actionIds" },
  {
    table: "meeting_outcome_candidates",
    column: "outcome_candidate_id",
    entitySet: "outcomeIds",
  },
  { table: "meeting_outcome_candidates", column: "meeting_id", entitySet: "meetingIds" },
  { table: "meeting_outcome_candidates", column: "agenda_item_id", entitySet: "agendaIds" },
  { table: "meeting_rulings", column: "ruling_id", entitySet: "rulingIds" },
  { table: "meeting_rulings", column: "meeting_id", entitySet: "meetingIds" },
  { table: "meeting_rulings", column: "agenda_item_id", entitySet: "agendaIds" },
  { table: "meeting_minutes", column: "minutes_id", entitySet: "minutesIds" },
  { table: "meeting_minutes", column: "meeting_id", entitySet: "meetingIds" },
  { table: "character_memories", column: "memory_id", entitySet: "memoryIds" },
  { table: "character_memories", column: "source_meeting_id", entitySet: "meetingIds" },
  {
    table: "character_conversation_turns",
    column: "turn_id",
    entitySet: "conversationTurnIds",
  },
  { table: "meeting_session_versions", column: "meeting_id", entitySet: "sessionIds" },
  {
    table: "meeting_outcome_candidate_versions",
    column: "outcome_candidate_id",
    entitySet: "outcomeIds",
  },
];

export const SAFE_SHARE_REFERENCE_CONTRACT = {
  resolution: {
    uniqueTarget: "required",
    ambiguity: "remove",
    unknown: "remove",
    missingTarget: "remove",
  },
  transforms: {
    single: "remove-field",
    array: "filter-items",
    polymorphic: "filter-items",
    unregistered: "validate-only-fail",
  },
  single: {
    meetingId: "meetingIds",
    currentMeetingId: "meetingIds",
    sourceMeetingId: "meetingIds",
    sessionId: "sessionIds",
    agendaItemId: "agendaIds",
    currentAgendaItemId: "agendaIds",
    nextAgendaItemId: "agendaIds",
    turnId: "turnIds",
    outcomeCandidateId: "outcomeIds",
    rulingId: "rulingIds",
    minutesId: "minutesIds",
    memoryId: "memoryIds",
    actionId: "actionIds",
    eventId: "eventIds",
    characterId: "characterIds",
    speakerId: "characterIds",
    proposerId: "characterIds",
    chairCharacterId: "characterIds",
    holderCharacterId: "characterIds",
    authorCharacterId: "characterIds",
    commanderCharacterId: "characterIds",
    currentSpeakerId: "characterIds",
    fromCharacterId: "characterIds",
    relatedCharacterId: "characterIds",
    rulerCharacterId: "characterIds",
    targetCharacterId: "characterIds",
    toCharacterId: "characterIds",
    officeId: "officeIds",
    currentOfficeId: "officeIds",
    initialOfficeId: "officeIds",
    policyId: "policyIds",
    templateId: "policyTemplateIds",
    regionId: "regionIds",
    contextRegionId: "regionIds",
    locationRegionId: "regionIds",
    modifierId: "modifierIds",
    scenarioId: "scenarioIds",
    dynastyId: "dynastyIds",
    relatedPolicyId: "policyIds",
    transcriptMemoryId: "memoryIds",
  } as const satisfies Record<string, keyof SafeShareEntitySets>,

  array: {
    meetingIds: "meetingIds",
    sessionIds: "sessionIds",
    agendaItemIds: "agendaIds",
    turnIds: "turnIds",
    sourceTurnIds: "turnIds",
    referencedTurnIds: "turnIds",
    outcomeCandidateIds: "outcomeIds",
    acceptedOutcomeCandidateIds: "outcomeIds",
    selectedOutcomeCandidateIds: "outcomeIds",
    rulingIds: "rulingIds",
    minutesIds: "minutesIds",
    memoryIds: "memoryIds",
    actionIds: "actionIds",
    eventIds: "eventIds",
    pendingEventIds: "eventIds",
    processedEventIds: "eventIds",
    queuedEventIds: "eventIds",
    firedEventIds: "eventIds",
    leakEventCandidateIds: "eventIds",
    deferredAgendaItemIds: "agendaIds",
    participantIds: "characterIds",
    coreCharacterIds: "characterIds",
    addressedCharacterIds: "characterIds",
    challengedCharacterIds: "characterIds",
    proposerIds: "characterIds",
    supporterIds: "characterIds",
    opponentIds: "characterIds",
    audienceCharacterIds: "characterIds",
    potentialAudienceIds: "characterIds",
    relatedCharacterIds: "characterIds",
    summarizedMemoryIds: "memoryIds",
    responsibleCharacterIds: "characterIds",
    requiredOfficeIds: "officeIds",
    allowedOfficeIds: "officeIds",
    regionIds: "regionIds",
    frontRegionIds: "regionIds",
    targetRegionIds: "regionIds",
    policyIds: "policyIds",
    policyTemplateIds: "policyTemplateIds",
  } as const satisfies Record<string, keyof SafeShareEntitySets>,
  polymorphic: {
    sourceIds: "source",
    relatedEntityIds: "related",
    targetEntityIds: "related",
  } as const satisfies Record<string, PolymorphicReferenceKind>,
  polymorphicSingle: {
    sourceId: "source",
    entityId: "related",
  } as const satisfies Record<string, PolymorphicReferenceKind>,
  sqliteRootArrays: SQLITE_ROOT_ARRAY_REFERENCE_CONTRACT,
  sqliteDirect: SQLITE_DIRECT_REFERENCE_CONTRACT,
  nonReferenceIds: new Set([
    "saveId",
    "commandId",
    "transactionId",
    "snapshotId",
    "lineageId",
    "topicIds",
    "actorId",
    "clientId",
    "defaultScenarioId",
    "exportedFromClientId",
    "factionId",
    "factionIds",
    "historicalOfficeIds",
    "institutionId",
    "institutionIds",
    "institutionPackId",
    "logId",
    "memberIds",
    "originalSaveId",
    "packId",
    "parentSaveId",
    "reportId",
    "requestId",
    "responsibleInstitutionId",
    "ruleId",
    "ruleIds",
    "sourceCommandId",
    "sourceInstitutionId",
    "sourceTxId",
    "stageId",
    "stageIds",
    "txId",
  ]),
} as const;

const SINGLE_REFERENCE_SETS = SAFE_SHARE_REFERENCE_CONTRACT.single;
const ARRAY_REFERENCE_SETS = SAFE_SHARE_REFERENCE_CONTRACT.array;
const GAME_STATE_MEETING_PARTICIPANT_ENTITY_SET =
  SAFE_SHARE_REFERENCE_CONTRACT.array.participantIds;

export interface SafeShareReferenceContext {
  readonly table: string;
  readonly column: string;
  readonly path: string;
}

const SCOPED_NON_REFERENCE_IDS: Readonly<Record<string, ReadonlySet<string>>> = {
  // 导出元数据中的谱系、客户端和默认剧本键是包管理标识，不解析为运行态实体。
  "saves.metadata_json": new Set([
    "clientId",
    "defaultScenarioId",
    "exportedFromClientId",
    "lineageId",
    "originalSaveId",
    "parentSaveId",
  ]),
  // GameStateSchema 已定义这些规则、制度、事务及包内标识；作用域仅限完整状态快照。
  "save_snapshots.state_json": SAFE_SHARE_REFERENCE_CONTRACT.nonReferenceIds,
  // session_json 的 saveId 是所属存档键；实体关系另由列、对象和时间线联合校验。
  "meeting_session_versions.session_json": new Set(["saveId"]),
  // 议程 topicIds 是主题标签，不是 safe-share 实体注册表中的实体引用。
  "meeting_agenda_item_versions.entity_json": new Set(["topicIds"]),
  // outcome version 的 saveId 是所属存档键，不是结果候选的实体边。
  "meeting_outcome_candidate_versions.entity_json": new Set(["saveId"]),
};

export function isRegisteredSafeShareStructuredIdField(
  field: string,
  context?: SafeShareReferenceContext,
): boolean {
  if (context && !context.path.endsWith(`.${field}`)) return false;
  const entityReference =
    field in SINGLE_REFERENCE_SETS ||
    field in ARRAY_REFERENCE_SETS ||
    field in SAFE_SHARE_REFERENCE_CONTRACT.polymorphic ||
    field in SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle;
  if (context) {
    if (entityReference) return `${context.table}.${context.column}` !== "saves.metadata_json";
    return SCOPED_NON_REFERENCE_IDS[`${context.table}.${context.column}`]?.has(field) ?? false;
  }
  return entityReference || SAFE_SHARE_REFERENCE_CONTRACT.nonReferenceIds.has(field);
}

function isUnsafeTypedReference(
  entities: SafeShareForbiddenEntities,
  entitySet: keyof SafeShareEntitySets,
  id: string,
): boolean {
  return !entities.known[entitySet].has(id) || entities[entitySet].has(id);
}

function sanitizeTypedReferences(value: unknown, entities: SafeShareForbiddenEntities): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTypedReferences(item, entities));
  }
  if (value === null || typeof value !== "object") return value;
  const sanitized = structuredClone(value) as Record<string, unknown>;
  for (const [key, item] of Object.entries(sanitized)) {
    const singleSet = SINGLE_REFERENCE_SETS[key as keyof typeof SINGLE_REFERENCE_SETS];
    if (
      singleSet &&
      typeof item === "string" &&
      isUnsafeTypedReference(entities, singleSet, item)
    ) {
      delete sanitized[key];
      continue;
    }
    const arraySet = ARRAY_REFERENCE_SETS[key as keyof typeof ARRAY_REFERENCE_SETS];
    if (arraySet && Array.isArray(item)) {
      sanitized[key] = item.filter(
        (id) => typeof id !== "string" || !isUnsafeTypedReference(entities, arraySet, id),
      );
      continue;
    }
    const polymorphicKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphic[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphic
      ];
    if (polymorphicKind && Array.isArray(item)) {
      sanitized[key] = item.filter(
        (id) =>
          typeof id !== "string" || !isUnsafePolymorphicReference(entities, id, polymorphicKind),
      );
      continue;
    }
    const polymorphicSingleKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle
      ];
    if (
      polymorphicSingleKind &&
      typeof item === "string" &&
      isUnsafePolymorphicReference(entities, item, polymorphicSingleKind)
    ) {
      delete sanitized[key];
      continue;
    }
    sanitized[key] = sanitizeTypedReferences(item, entities);
  }
  return sanitized;
}

function containsForbiddenTypedReference(
  value: unknown,
  entities: SafeShareForbiddenEntities,
  ignoredKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenTypedReference(item, entities, ignoredKeys));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (ignoredKeys.has(key)) continue;
    const singleSet = SINGLE_REFERENCE_SETS[key as keyof typeof SINGLE_REFERENCE_SETS];
    if (singleSet && typeof item === "string" && entities[singleSet].has(item)) return true;
    const arraySet = ARRAY_REFERENCE_SETS[key as keyof typeof ARRAY_REFERENCE_SETS];
    if (
      arraySet &&
      Array.isArray(item) &&
      item.some((id) => typeof id === "string" && entities[arraySet].has(id))
    ) {
      return true;
    }
    const polymorphicKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphic[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphic
      ];
    if (
      polymorphicKind &&
      Array.isArray(item) &&
      item.some(
        (id) =>
          typeof id === "string" && isUnsafePolymorphicReference(entities, id, polymorphicKind),
      )
    ) {
      return true;
    }
    const polymorphicSingleKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle
      ];
    if (
      polymorphicSingleKind &&
      typeof item === "string" &&
      isUnsafePolymorphicReference(entities, item, polymorphicSingleKind)
    ) {
      return true;
    }
    if (containsForbiddenTypedReference(item, entities, ignoredKeys)) return true;
  }
  return false;
}

function containsUnsafeTypedReference(
  value: unknown,
  entities: SafeShareForbiddenEntities,
  ignoredKeys: ReadonlySet<string> = new Set(),
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeTypedReference(item, entities, ignoredKeys));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (ignoredKeys.has(key)) continue;
    const singleSet = SINGLE_REFERENCE_SETS[key as keyof typeof SINGLE_REFERENCE_SETS];
    if (
      singleSet &&
      typeof item === "string" &&
      isUnsafeTypedReference(entities, singleSet, item)
    ) {
      return true;
    }
    const arraySet = ARRAY_REFERENCE_SETS[key as keyof typeof ARRAY_REFERENCE_SETS];
    if (
      arraySet &&
      Array.isArray(item) &&
      item.some((id) => typeof id === "string" && isUnsafeTypedReference(entities, arraySet, id))
    ) {
      return true;
    }
    const polymorphicKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphic[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphic
      ];
    if (
      polymorphicKind &&
      Array.isArray(item) &&
      item.some(
        (id) =>
          typeof id === "string" && isUnsafePolymorphicReference(entities, id, polymorphicKind),
      )
    ) {
      return true;
    }
    const polymorphicSingleKind =
      SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle[
        key as keyof typeof SAFE_SHARE_REFERENCE_CONTRACT.polymorphicSingle
      ];
    if (
      polymorphicSingleKind &&
      typeof item === "string" &&
      isUnsafePolymorphicReference(entities, item, polymorphicSingleKind)
    ) {
      return true;
    }
    if (containsUnsafeTypedReference(item, entities, ignoredKeys)) return true;
  }
  return false;
}

function collectSafeShareForbiddenIds(
  database: DatabaseSync,
  saveId: string,
  state: GameState,
): SafeShareForbiddenEntities {
  const forbidden = createForbiddenEntities();
  for (const sourceId of state.meta.sourceIds)
    addEntityId(forbidden.known.historicalSourceIds, sourceId);
  for (const character of Object.values(state.characters))
    addEntityId(forbidden.known.characterIds, character.characterId);
  addEntityId(forbidden.known.characterIds, "emperor");
  for (const office of Object.values(state.offices))
    addEntityId(forbidden.known.officeIds, office.officeId);
  for (const policy of Object.values(state.policies)) {
    addEntityId(forbidden.known.policyIds, policy.policyId);
    addEntityId(forbidden.known.policyTemplateIds, policy.templateId);
  }
  for (const region of Object.values(state.regions))
    addEntityId(forbidden.known.regionIds, region.regionId);
  for (const modifier of Object.values(state.modifiers))
    addEntityId(forbidden.known.modifierIds, modifier.modifierId);
  addEntityId(forbidden.known.scenarioIds, state.scenarioId);
  addEntityId(forbidden.known.dynastyIds, state.dynastyId);
  for (const meeting of Object.values(state.meetings)) {
    addEntityId(forbidden.projectedMeetingIds, meeting.meetingId);
    addEntityId(forbidden.known.meetingIds, meeting.meetingId);
    if (
      meeting.visibility === "private" ||
      meeting.visibility === "sealed" ||
      meeting.type === "private-audience"
    ) {
      addForbiddenId(forbidden.meetingIds, meeting.meetingId);
    }
  }
  for (const eventId of [
    ...state.eventQueue.pendingEventIds,
    ...state.eventQueue.processedEventIds,
    ...state.hidden.queuedEventIds,
  ]) {
    addEntityId(forbidden.known.eventIds, eventId);
  }
  for (const eventId of state.hidden.queuedEventIds) addForbiddenId(forbidden.eventIds, eventId);
  for (const meetingId of confidentialMeetingIds(database, saveId)) {
    addForbiddenId(forbidden.meetingIds, meetingId);
    addForbiddenId(forbidden.sessionIds, meetingId);
  }

  const sessions = readRows<{
    meeting_id: string;
    current_agenda_item_id: string | null;
    pending_agent_action_json: string | null;
  }>(
    database,
    `SELECT meeting_id, current_agenda_item_id, pending_agent_action_json
     FROM meeting_sessions WHERE save_id = ?`,
    saveId,
  );
  for (const session of sessions) {
    addEntityId(forbidden.known.meetingIds, session.meeting_id);
    addEntityId(forbidden.known.sessionIds, session.meeting_id);
  }

  const agendas = readRows<{
    agenda_item_id: string;
    meeting_id: string;
    visibility: string;
  }>(
    database,
    `SELECT agenda.agenda_item_id, agenda.meeting_id, agenda.visibility
     FROM meeting_agenda_items agenda
     JOIN meeting_sessions session ON session.meeting_id = agenda.meeting_id
     WHERE session.save_id = ?`,
    saveId,
  );
  const turns = readRows<{
    turn_id: string;
    meeting_id: string;
    agenda_item_id: string | null;
    visibility: string;
    action_id: string | null;
  }>(
    database,
    `SELECT turn_id, meeting_id, agenda_item_id, visibility, action_id
     FROM meeting_turns WHERE save_id = ?`,
    saveId,
  );
  const outcomes = readRows<{
    outcome_candidate_id: string;
    meeting_id: string;
    agenda_item_id: string;
    source_turn_ids_json: string;
  }>(
    database,
    `SELECT outcome_candidate_id, meeting_id, agenda_item_id, source_turn_ids_json
     FROM meeting_outcome_candidates WHERE save_id = ?`,
    saveId,
  );
  const rulings = readRows<{
    ruling_id: string;
    meeting_id: string;
    agenda_item_id: string;
    result_json: string;
  }>(
    database,
    `SELECT ruling_id, meeting_id, agenda_item_id, result_json
     FROM meeting_rulings WHERE save_id = ?`,
    saveId,
  );
  const minutes = readRows<{
    minutes_id: string;
    meeting_id: string;
    kind: string;
    entries_json: string;
    accepted_outcome_candidate_ids_json: string;
    deferred_agenda_item_ids_json: string;
  }>(
    database,
    `SELECT minutes_id, meeting_id, kind, entries_json,
            accepted_outcome_candidate_ids_json, deferred_agenda_item_ids_json
     FROM meeting_minutes WHERE save_id = ?`,
    saveId,
  );
  const memories = readRows<{
    memory_id: string;
    visibility: string;
    source_meeting_id: string | null;
    related_entity_ids_json: string;
  }>(
    database,
    `SELECT memory_id, visibility, source_meeting_id, related_entity_ids_json
     FROM character_memories WHERE save_id = ?`,
    saveId,
  );
  const conversationTurns = readRows<{ turn_id: string; mode: string }>(
    database,
    `SELECT turn_id, mode FROM character_conversation_turns WHERE save_id = ?`,
    saveId,
  );
  const sessionVersions = readRows<{ meeting_id: string; session_json: string }>(
    database,
    `SELECT meeting_id, session_json FROM meeting_session_versions WHERE save_id = ?`,
    saveId,
  );

  for (const agenda of agendas) addEntityId(forbidden.known.agendaIds, agenda.agenda_item_id);
  for (const turn of turns) {
    addEntityId(forbidden.known.turnIds, turn.turn_id);
    addEntityId(forbidden.known.actionIds, turn.action_id);
  }
  for (const outcome of outcomes)
    addEntityId(forbidden.known.outcomeIds, outcome.outcome_candidate_id);
  for (const ruling of rulings) addEntityId(forbidden.known.rulingIds, ruling.ruling_id);
  for (const item of minutes) addEntityId(forbidden.known.minutesIds, item.minutes_id);
  for (const memory of memories) addEntityId(forbidden.known.memoryIds, memory.memory_id);
  for (const turn of conversationTurns)
    addEntityId(forbidden.known.conversationTurnIds, turn.turn_id);
  const pendingActionId = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const pending = (value as { pendingAgentAction?: unknown }).pendingAgentAction;
    if (pending === null || typeof pending !== "object" || Array.isArray(pending)) return undefined;
    const actionId = (pending as { actionId?: unknown }).actionId;
    return typeof actionId === "string" ? actionId : undefined;
  };
  for (const session of sessions) {
    const actionId = pendingActionId({
      pendingAgentAction: parseJson(session.pending_agent_action_json),
    });
    addEntityId(forbidden.known.actionIds, actionId);
  }
  for (const version of sessionVersions) {
    addEntityId(forbidden.known.actionIds, pendingActionId(parseJson(version.session_json)));
  }

  for (const agenda of agendas) {
    if (
      forbidden.meetingIds.has(agenda.meeting_id) ||
      agenda.visibility === "private" ||
      agenda.visibility === "sealed"
    ) {
      addForbiddenId(forbidden.agendaIds, agenda.agenda_item_id);
    }
  }
  for (const turn of turns) {
    if (
      forbidden.meetingIds.has(turn.meeting_id) ||
      turn.visibility === "private" ||
      turn.visibility === "sealed"
    ) {
      addForbiddenId(forbidden.turnIds, turn.turn_id);
    }
  }
  for (const outcome of outcomes) {
    if (forbidden.meetingIds.has(outcome.meeting_id)) {
      addForbiddenId(forbidden.outcomeIds, outcome.outcome_candidate_id);
    }
  }
  for (const ruling of rulings) {
    if (forbidden.meetingIds.has(ruling.meeting_id)) {
      addForbiddenId(forbidden.rulingIds, ruling.ruling_id);
    }
  }
  for (const item of minutes) {
    if (forbidden.meetingIds.has(item.meeting_id) || item.kind === "private") {
      addForbiddenId(forbidden.minutesIds, item.minutes_id);
    }
  }
  for (const memory of memories) {
    if (
      memory.visibility === "private" ||
      memory.visibility === "sealed" ||
      (memory.source_meeting_id !== null && forbidden.meetingIds.has(memory.source_meeting_id))
    ) {
      addForbiddenId(forbidden.memoryIds, memory.memory_id);
    }
  }
  for (const turn of conversationTurns) {
    if (turn.mode === "private-audience" || turn.mode === "secret-council") {
      addForbiddenId(forbidden.conversationTurnIds, turn.turn_id);
    }
  }
  const markPrivatePendingAction = (
    meetingId: string,
    currentAgendaItemId: unknown,
    actionId: string | undefined,
  ): void => {
    if (
      actionId !== undefined &&
      (forbidden.meetingIds.has(meetingId) ||
        (typeof currentAgendaItemId === "string" && forbidden.agendaIds.has(currentAgendaItemId)))
    ) {
      addForbiddenId(forbidden.actionIds, actionId);
    }
  };
  for (const session of sessions) {
    markPrivatePendingAction(
      session.meeting_id,
      session.current_agenda_item_id,
      pendingActionId({ pendingAgentAction: parseJson(session.pending_agent_action_json) }),
    );
  }
  let changed: boolean;
  do {
    changed = false;
    for (const turn of turns) {
      if (turn.agenda_item_id !== null && forbidden.agendaIds.has(turn.agenda_item_id)) {
        changed = addForbiddenId(forbidden.turnIds, turn.turn_id) || changed;
      }
      if (forbidden.turnIds.has(turn.turn_id) && turn.action_id !== null) {
        changed = addForbiddenId(forbidden.actionIds, turn.action_id) || changed;
      }
    }
    for (const outcome of outcomes) {
      if (
        forbidden.agendaIds.has(outcome.agenda_item_id) ||
        jsonIdArrayContains(outcome.source_turn_ids_json, forbidden.turnIds)
      ) {
        changed = addForbiddenId(forbidden.outcomeIds, outcome.outcome_candidate_id) || changed;
      }
    }
    for (const ruling of rulings) {
      if (
        forbidden.agendaIds.has(ruling.agenda_item_id) ||
        containsForbiddenTypedReference(parseJson(ruling.result_json), forbidden)
      ) {
        changed = addForbiddenId(forbidden.rulingIds, ruling.ruling_id) || changed;
      }
    }
    for (const item of minutes) {
      const entries = parseJson(item.entries_json);
      if (
        containsForbiddenTypedReference(entries, forbidden) ||
        jsonIdArrayContains(item.accepted_outcome_candidate_ids_json, forbidden.outcomeIds) ||
        jsonIdArrayContains(item.deferred_agenda_item_ids_json, forbidden.agendaIds)
      ) {
        changed = addForbiddenId(forbidden.minutesIds, item.minutes_id) || changed;
      }
    }
    for (const memory of memories) {
      const relatedIds = parseJson(memory.related_entity_ids_json);
      if (
        Array.isArray(relatedIds) &&
        relatedIds.some(
          (id) => typeof id === "string" && isUnsafePolymorphicReference(forbidden, id, "related"),
        )
      ) {
        changed = addForbiddenId(forbidden.memoryIds, memory.memory_id) || changed;
      }
    }
  } while (changed);

  return forbidden;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function structuredColumns(database: DatabaseSync): Array<{
  table: string;
  jsonColumns: string[];
  idColumns: string[];
}> {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name: string }>;
  return tables.map(({ name: table }) => {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all() as unknown as Array<{
      name: string;
    }>;
    return {
      table,
      jsonColumns: columns.map(({ name }) => name).filter((name) => name.endsWith("_json")),
      idColumns: columns
        .map(({ name }) => name)
        .filter((name) => name.endsWith("_id") || name.endsWith("_ids")),
    };
  });
}

const ROOT_ARRAY_REFERENCES = SAFE_SHARE_REFERENCE_CONTRACT.sqliteRootArrays;
const DIRECT_REFERENCES = SAFE_SHARE_REFERENCE_CONTRACT.sqliteDirect;

function filterRootReferenceArray(
  value: unknown,
  reference: RootArrayReference,
  entities: SafeShareForbiddenEntities,
): unknown {
  if (!Array.isArray(value)) return value;
  if ("polymorphic" in reference) {
    return value.filter(
      (item) =>
        typeof item !== "string" ||
        !isUnsafePolymorphicReference(entities, item, reference.polymorphic),
    );
  }
  return value.filter(
    (item) =>
      typeof item !== "string" || !isUnsafeTypedReference(entities, reference.entitySet, item),
  );
}

function updateJsonArrayColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  reference: RootArrayReference,
  entities: SafeShareForbiddenEntities,
): void {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return;
  const rows = database
    .prepare(
      `SELECT rowid AS export_rowid, ${quoteIdentifier(column)} AS value
       FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`,
    )
    .all() as unknown as Array<{ export_rowid: number; value: unknown }>;
  const update = database.prepare(
    `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`,
  );
  for (const row of rows) {
    if (typeof row.value !== "string") continue;
    const parsed = JSON.parse(row.value) as unknown;
    const sanitized = filterRootReferenceArray(parsed, reference, entities);
    if (stableStringify(parsed) !== stableStringify(sanitized)) {
      update.run(stableStringify(sanitized), row.export_rowid);
    }
  }
}

function normalizeSessionDocument(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SaveSystemError("SAVE_EXPORT_FAILED", "会议历史 session_json 不是对象");
  }
  const session = structuredClone(value) as Record<string, unknown>;
  for (const key of [
    "startedAtRevision",
    "concludedAtRevision",
    "currentAgendaItemId",
    "currentSpeakerId",
    "pendingPlayerAction",
    "pendingAgentAction",
    "pauseReason",
    "failureCode",
  ]) {
    if (session[key] === null) delete session[key];
  }
  return session;
}

type AgendaShareability =
  "public" | "private" | "missing" | "deleted" | "ambiguous" | "relation-mismatch";

function resolveAgendaShareabilityAtRevision(
  database: DatabaseSync,
  input: {
    saveId: string;
    meetingId: string;
    agendaItemId: string;
    referenceRevision: number;
  },
): AgendaShareability {
  const rows = database
    .prepare(
      `SELECT agenda.save_id, agenda.meeting_id, agenda.agenda_item_id,
              agenda.state_revision, agenda.entity_json
       FROM meeting_agenda_item_versions agenda
       WHERE agenda.save_id = ?
         AND agenda.meeting_id = ?
         AND agenda.agenda_item_id = ?
         AND agenda.state_revision <= ?
         AND NOT EXISTS (
           SELECT 1 FROM save_rollback_events rollback
           WHERE rollback.save_id = agenda.save_id
             AND rollback.result_revision <= ?
             AND rollback.result_revision > agenda.state_revision
             AND rollback.target_revision < agenda.state_revision
         )
       ORDER BY agenda.state_revision DESC, agenda.version_id DESC`,
    )
    .all(
      input.saveId,
      input.meetingId,
      input.agendaItemId,
      input.referenceRevision,
      input.referenceRevision,
    ) as unknown as Array<{
    save_id: string;
    meeting_id: string;
    agenda_item_id: string;
    state_revision: number;
    entity_json: string;
  }>;
  if (rows.length === 0) return "missing";
  const latestRevision = Number(rows[0]!.state_revision);
  const latest = rows.filter((row) => Number(row.state_revision) === latestRevision);
  if (latest.length !== 1) return "ambiguous";
  const row = latest[0]!;
  const parsed = MeetingAgendaItemSchema.safeParse(JSON.parse(row.entity_json));
  if (
    !parsed.success ||
    row.save_id !== input.saveId ||
    row.meeting_id !== input.meetingId ||
    row.agenda_item_id !== input.agendaItemId ||
    parsed.data.meetingId !== input.meetingId ||
    parsed.data.agendaItemId !== input.agendaItemId
  ) {
    return "relation-mismatch";
  }
  const agenda = parsed.data;
  return agenda.visibility === "private" || agenda.visibility === "sealed" ? "private" : "public";
}

function sanitizeSessionRuntimeFields(
  session: Record<string, unknown>,
  entities: SafeShareForbiddenEntities,
  meetingShareability: AgendaShareability,
  agendaShareability: (agendaItemId: string) => AgendaShareability,
): Record<string, unknown> {
  const sanitized = structuredClone(session);
  const meetingIsPrivate =
    meetingShareability !== "public" ||
    sanitized.visibility === "private" ||
    sanitized.visibility === "sealed" ||
    sanitized.type === "private-audience" ||
    sanitized.type === "secret-council";
  const resolveAgenda = (agendaItemId: string): AgendaShareability =>
    meetingIsPrivate ? "private" : agendaShareability(agendaItemId);
  if (Array.isArray(sanitized.participantIds)) {
    sanitized.participantIds = sanitized.participantIds.filter(
      (id) => typeof id !== "string" || !isUnsafeTypedReference(entities, "characterIds", id),
    );
  }
  if (Array.isArray(sanitized.agendaItemIds)) {
    sanitized.agendaItemIds = sanitized.agendaItemIds.filter(
      (id) => typeof id !== "string" || resolveAgenda(id) === "public",
    );
  }
  if (Array.isArray(sanitized.outcomeCandidateIds)) {
    sanitized.outcomeCandidateIds = sanitized.outcomeCandidateIds.filter(
      (id) => typeof id !== "string" || !isUnsafeTypedReference(entities, "outcomeIds", id),
    );
  }
  const redactedCurrentAgenda =
    typeof sanitized.currentAgendaItemId === "string" &&
    resolveAgenda(sanitized.currentAgendaItemId) !== "public";
  if (redactedCurrentAgenda) {
    delete sanitized.currentAgendaItemId;
  }
  const pending = sanitized.pendingAgentAction;
  const redactedPendingAgent =
    redactedCurrentAgenda ||
    (pending !== undefined && containsUnsafeTypedReference(pending, entities));
  if (redactedPendingAgent) {
    delete sanitized.pendingAgentAction;
    delete sanitized.currentSpeakerId;
    if (sanitized.status === "waiting-for-agent") sanitized.status = "in-progress";
  } else if (
    typeof sanitized.currentSpeakerId === "string" &&
    isUnsafeTypedReference(entities, "characterIds", sanitized.currentSpeakerId)
  ) {
    delete sanitized.currentSpeakerId;
  }
  if (redactedCurrentAgenda) {
    delete sanitized.pendingPlayerAction;
    if (sanitized.status === "waiting-for-player") sanitized.status = "in-progress";
  }
  return sanitized;
}

function sanitizeSessionDocument(
  value: unknown,
  entities: SafeShareForbiddenEntities,
  meetingShareability: AgendaShareability,
  agendaShareability: (agendaItemId: string) => AgendaShareability,
): unknown {
  const session = sanitizeSessionRuntimeFields(
    normalizeSessionDocument(value),
    entities,
    meetingShareability,
    agendaShareability,
  );
  return MeetingSessionStateSchema.parse(session);
}

function sanitizeKnownDatabaseReferences(
  database: DatabaseSync,
  entities: SafeShareForbiddenEntities,
): void {
  const tables = new Set(structuredColumns(database).map(({ table }) => table));
  const currentAgendaExists = tables.has("meeting_agenda_items")
    ? database.prepare(
        `SELECT 1
           FROM meeting_agenda_items
           WHERE meeting_id = ? AND agenda_item_id = ?`,
      )
    : undefined;
  const currentSessionVersionRowIds = new Set<number>();
  for (const [key, reference] of Object.entries(ROOT_ARRAY_REFERENCES)) {
    // current session 的全部引用字段由下方完整对象 sanitizer 校验后单条 UPDATE 原子写回。
    if (key.startsWith("meeting_sessions.")) continue;
    const separator = key.indexOf(".");
    updateJsonArrayColumn(
      database,
      key.slice(0, separator),
      key.slice(separator + 1),
      reference,
      entities,
    );
  }
  if (tables.has("meeting_sessions")) {
    const saveHeads = new Map(
      (
        database.prepare("SELECT save_id, head_revision FROM saves").all() as unknown as Array<{
          save_id: string;
          head_revision: number;
        }>
      ).map((row) => [row.save_id, Number(row.head_revision)]),
    );
    const sessionRows = database
      .prepare(
        `SELECT rowid AS export_rowid, save_id, meeting_id, type, status, title, purpose,
                created_at_revision, started_at_revision, concluded_at_revision,
                meeting_version, turn_number, participant_ids_json, chair_character_id,
                agenda_item_ids_json, current_agenda_item_id, current_speaker_id,
                pending_player_action_json, pending_agent_action_json, limits_json, used_turns,
                visibility, outcome_candidate_ids_json, pause_reason, failure_code,
                created_at, updated_at
         FROM meeting_sessions`,
      )
      .all() as unknown as Array<{
      export_rowid: number;
      save_id: string;
      meeting_id: string;
      type: string;
      meeting_version: number;
      status: string;
      title: string;
      purpose: string;
      created_at_revision: number;
      started_at_revision: number | null;
      concluded_at_revision: number | null;
      turn_number: number;
      participant_ids_json: string;
      chair_character_id: string;
      agenda_item_ids_json: string;
      current_agenda_item_id: string | null;
      current_speaker_id: string | null;
      pending_player_action_json: string | null;
      pending_agent_action_json: string | null;
      limits_json: string;
      used_turns: number;
      visibility: string;
      outcome_candidate_ids_json: string;
      pause_reason: string | null;
      failure_code: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const updateSession = database.prepare(
      `UPDATE meeting_sessions
       SET status = ?, participant_ids_json = ?, chair_character_id = ?,
           agenda_item_ids_json = ?, current_agenda_item_id = ?, current_speaker_id = ?,
           pending_player_action_json = ?, pending_agent_action_json = ?,
           outcome_candidate_ids_json = ?
       WHERE rowid = ?`,
    );
    for (const row of sessionRows) {
      const referenceRevision = saveHeads.get(row.save_id);
      if (referenceRevision === undefined) continue;
      const logical = database
        .prepare(
          `SELECT rowid AS version_rowid, session_json
           FROM meeting_session_versions version
           WHERE version.save_id = ? AND version.meeting_id = ?
             AND version.state_revision <= ?
             AND NOT EXISTS (
               SELECT 1 FROM save_rollback_events rollback
               WHERE rollback.save_id = version.save_id
                 AND rollback.result_revision <= ?
                 AND rollback.result_revision > version.state_revision
                 AND rollback.target_revision < version.state_revision
             )
           ORDER BY version.state_revision DESC, version.meeting_version DESC
           LIMIT 1`,
        )
        .get(row.save_id, row.meeting_id, referenceRevision, referenceRevision) as
        { version_rowid: number; session_json: string } | undefined;
      if (logical) currentSessionVersionRowIds.add(Number(logical.version_rowid));
      const sourceDocument = logical
        ? JSON.parse(logical.session_json)
        : {
            meetingId: row.meeting_id,
            saveId: row.save_id,
            type: row.type,
            status: row.status,
            title: row.title,
            purpose: row.purpose,
            createdAtRevision: row.created_at_revision,
            startedAtRevision: row.started_at_revision,
            concludedAtRevision: row.concluded_at_revision,
            meetingVersion: row.meeting_version,
            turnNumber: row.turn_number,
            participantIds: parseJson(row.participant_ids_json),
            chairCharacterId: row.chair_character_id,
            agendaItemIds: parseJson(row.agenda_item_ids_json),
            currentAgendaItemId: row.current_agenda_item_id,
            currentSpeakerId: row.current_speaker_id,
            pendingPlayerAction: parseJson(row.pending_player_action_json),
            pendingAgentAction: parseJson(row.pending_agent_action_json),
            limits: parseJson(row.limits_json),
            usedTurns: row.used_turns,
            visibility: row.visibility,
            outcomeCandidateIds: parseJson(row.outcome_candidate_ids_json),
            pauseReason: row.pause_reason,
            failureCode: row.failure_code,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
      const normalized = MeetingSessionStateSchema.parse(
        sanitizeSessionRuntimeFields(
          normalizeSessionDocument(sourceDocument),
          entities,
          entities.projectedMeetingIds.has(row.meeting_id) &&
            sourceDocument.meetingId === row.meeting_id &&
            sourceDocument.saveId === row.save_id
            ? "public"
            : "missing",
          (agendaItemId) => {
            if (!currentAgendaExists?.get(row.meeting_id, agendaItemId)) {
              return "deleted";
            }
            return resolveAgendaShareabilityAtRevision(database, {
              saveId: row.save_id,
              meetingId: row.meeting_id,
              agendaItemId,
              referenceRevision,
            });
          },
        ),
      );
      updateSession.run(
        normalized.status,
        stableStringify(normalized.participantIds),
        normalized.chairCharacterId,
        stableStringify(normalized.agendaItemIds),
        normalized.currentAgendaItemId ?? null,
        normalized.currentSpeakerId ?? null,
        normalized.pendingPlayerAction === undefined
          ? null
          : stableStringify(normalized.pendingPlayerAction),
        normalized.pendingAgentAction === undefined
          ? null
          : stableStringify(normalized.pendingAgentAction),
        stableStringify(normalized.outcomeCandidateIds),
        row.export_rowid,
      );
    }
  }
  if (tables.has("meeting_session_versions")) {
    const historyRows = database
      .prepare(
        `SELECT rowid AS export_rowid, save_id, meeting_id, state_revision,
                session_json AS value
         FROM meeting_session_versions`,
      )
      .all() as unknown as Array<{
      export_rowid: number;
      save_id: string;
      meeting_id: string;
      state_revision: number;
      value: unknown;
    }>;
    const updateHistory = database.prepare(
      "UPDATE meeting_session_versions SET session_json = ? WHERE rowid = ?",
    );
    for (const row of historyRows) {
      if (typeof row.value !== "string") continue;
      const document = JSON.parse(row.value) as Record<string, unknown>;
      const isCurrentLogicalVersion = currentSessionVersionRowIds.has(row.export_rowid);
      const sanitized = sanitizeSessionDocument(
        document,
        entities,
        document.meetingId === row.meeting_id &&
          document.saveId === row.save_id &&
          (!isCurrentLogicalVersion || entities.projectedMeetingIds.has(row.meeting_id))
          ? "public"
          : "missing",
        (agendaItemId) => {
          if (isCurrentLogicalVersion && !currentAgendaExists?.get(row.meeting_id, agendaItemId)) {
            return "deleted";
          }
          return resolveAgendaShareabilityAtRevision(database, {
            saveId: row.save_id,
            meetingId: row.meeting_id,
            agendaItemId,
            referenceRevision: Number(row.state_revision),
          });
        },
      );
      updateHistory.run(stableStringify(sanitized), row.export_rowid);
    }
  }
  if (tables.has("meeting_agenda_item_versions")) {
    const agendaHistoryRows = database
      .prepare(
        `SELECT rowid AS export_rowid, save_id, meeting_id, agenda_item_id,
                entity_json AS value
         FROM meeting_agenda_item_versions`,
      )
      .all() as unknown as Array<{
      export_rowid: number;
      save_id: string;
      meeting_id: string;
      agenda_item_id: string;
      value: unknown;
    }>;
    const updateAgendaHistory = database.prepare(
      "UPDATE meeting_agenda_item_versions SET entity_json = ? WHERE rowid = ?",
    );
    const deleteAgendaHistory = database.prepare(
      "DELETE FROM meeting_agenda_item_versions WHERE rowid = ?",
    );
    for (const row of agendaHistoryRows) {
      if (typeof row.value !== "string") continue;
      const agenda = MeetingAgendaItemSchema.parse(JSON.parse(row.value));
      if (
        agenda.meetingId !== row.meeting_id ||
        agenda.agendaItemId !== row.agenda_item_id ||
        agenda.visibility === "private" ||
        agenda.visibility === "sealed"
      ) {
        deleteAgendaHistory.run(row.export_rowid);
        continue;
      }
      if (Array.isArray(agenda.relatedEntityIds)) {
        agenda.relatedEntityIds = agenda.relatedEntityIds.filter(
          (id) => typeof id !== "string" || !isUnsafePolymorphicReference(entities, id, "related"),
        );
      }
      updateAgendaHistory.run(
        stableStringify(MeetingAgendaItemSchema.parse(agenda)),
        row.export_rowid,
      );
    }
  }
  if (tables.has("meeting_outcome_candidate_versions")) {
    const outcomeHistoryRows = database
      .prepare(
        `SELECT rowid AS export_rowid, save_id, meeting_id, outcome_candidate_id,
                entity_json AS value
         FROM meeting_outcome_candidate_versions`,
      )
      .all() as unknown as Array<{
      export_rowid: number;
      save_id: string;
      meeting_id: string;
      outcome_candidate_id: string;
      value: unknown;
    }>;
    const updateOutcomeHistory = database.prepare(
      "UPDATE meeting_outcome_candidate_versions SET entity_json = ? WHERE rowid = ?",
    );
    const deleteOutcomeHistory = database.prepare(
      "DELETE FROM meeting_outcome_candidate_versions WHERE rowid = ?",
    );
    for (const row of outcomeHistoryRows) {
      if (typeof row.value !== "string") continue;
      const sanitized = sanitizeTypedReferences(JSON.parse(row.value), entities);
      const parsed = MeetingOutcomeCandidateSchema.safeParse(sanitized);
      if (
        !parsed.success ||
        parsed.data.saveId !== row.save_id ||
        parsed.data.meetingId !== row.meeting_id ||
        parsed.data.outcomeCandidateId !== row.outcome_candidate_id
      ) {
        deleteOutcomeHistory.run(row.export_rowid);
        continue;
      }
      updateOutcomeHistory.run(stableStringify(parsed.data), row.export_rowid);
    }
  }
  if (tables.has("meeting_rulings")) {
    const rulingRows = database
      .prepare("SELECT rowid AS export_rowid, result_json AS value FROM meeting_rulings")
      .all() as unknown as Array<{ export_rowid: number; value: unknown }>;
    const updateRuling = database.prepare(
      "UPDATE meeting_rulings SET result_json = ? WHERE rowid = ?",
    );
    for (const row of rulingRows) {
      if (typeof row.value !== "string") continue;
      const parsed = JSON.parse(row.value) as unknown;
      const sanitized = sanitizeTypedReferences(parsed, entities);
      if (stableStringify(parsed) !== stableStringify(sanitized)) {
        updateRuling.run(stableStringify(sanitized), row.export_rowid);
      }
    }
  }
}

function rootArrayContainsForbiddenReference(
  value: unknown,
  reference: RootArrayReference,
  entities: SafeShareForbiddenEntities,
): boolean {
  if (!Array.isArray(value)) return false;
  if ("polymorphic" in reference) {
    return value.some(
      (item) =>
        typeof item === "string" &&
        isUnsafePolymorphicReference(entities, item, reference.polymorphic),
    );
  }
  return value.some(
    (item) =>
      typeof item === "string" && isUnsafeTypedReference(entities, reference.entitySet, item),
  );
}

function containsUnsafeGameStateMeetingParticipantReference(
  value: unknown,
  entities: SafeShareForbiddenEntities,
): boolean {
  const parsed = GameStateSchema.safeParse(value);
  if (!parsed.success) return true;
  return Object.values(parsed.data.meetings).some((meeting) =>
    meeting.participantIds.some((id) =>
      isUnsafeTypedReference(entities, GAME_STATE_MEETING_PARTICIPANT_ENTITY_SET, id),
    ),
  );
}

function findUnregisteredForbiddenReference(
  value: unknown,
  context: Omit<SafeShareReferenceContext, "path">,
  path = "$",
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnregisteredForbiddenReference(value[index], context, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    const registered = isRegisteredSafeShareStructuredIdField(key, { ...context, path: itemPath });
    if (!registered && /Ids?$/.test(key)) {
      return itemPath;
    }
    const nested = findUnregisteredForbiddenReference(item, context, itemPath);
    if (nested) return nested;
  }
  return undefined;
}

function assertNoForbiddenStructuredReferences(
  database: DatabaseSync,
  entities: SafeShareForbiddenEntities,
): void {
  for (const { table, column, entitySet } of DIRECT_REFERENCES) {
    try {
      const rows = database
        .prepare(
          `SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}
           WHERE ${quoteIdentifier(column)} IS NOT NULL`,
        )
        .all() as unknown as Array<{ value: unknown }>;
      if (
        rows.some(
          ({ value }) =>
            typeof value === "string" && isUnsafeTypedReference(entities, entitySet, value),
        )
      ) {
        throw new SaveSystemError(
          "SAVE_EXPORT_FAILED",
          `安全分享仍含私密 typed 引用：${table}.${column}`,
        );
      }
    } catch (error) {
      if (error instanceof SaveSystemError) throw error;
      // 兼容尚无对应 Phase 3/4 表的旧库。
    }
  }
  for (const { table, jsonColumns } of structuredColumns(database)) {
    for (const column of jsonColumns) {
      const rows = database
        .prepare(
          `SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}
           WHERE ${quoteIdentifier(column)} IS NOT NULL`,
        )
        .all() as unknown as Array<{ value: unknown }>;
      const rootReference = ROOT_ARRAY_REFERENCES[`${table}.${column}`];
      for (const { value } of rows) {
        if (typeof value !== "string") continue;
        const parsed = JSON.parse(value) as unknown;
        const unregisteredPath = findUnregisteredForbiddenReference(parsed, { table, column });
        if (unregisteredPath) {
          throw new SaveSystemError(
            "SAVE_EXPORT_FAILED",
            `安全分享仍含未登记的结构化引用：${table}.${column}:${unregisteredPath}`,
          );
        }
        const ignoredVersionLocalKeys =
          table === "meeting_session_versions" && column === "session_json"
            ? new Set(["agendaItemId", "agendaItemIds", "currentAgendaItemId"])
            : table === "meeting_agenda_item_versions" && column === "entity_json"
              ? new Set(["agendaItemId"])
              : undefined;
        const containsUnsafeReference =
          table === "save_snapshots" && column === "state_json"
            ? containsForbiddenTypedReference(parsed, entities, ignoredVersionLocalKeys) ||
              containsUnsafeGameStateMeetingParticipantReference(parsed, entities)
            : containsUnsafeTypedReference(parsed, entities, ignoredVersionLocalKeys);
        if (
          (rootReference && rootArrayContainsForbiddenReference(parsed, rootReference, entities)) ||
          containsUnsafeReference
        ) {
          throw new SaveSystemError(
            "SAVE_EXPORT_FAILED",
            `安全分享仍含私密 typed JSON 引用：${table}.${column}`,
          );
        }
      }
    }
  }
}

function sanitizeState(
  input: GameState,
  options: ExportPayloadOptions,
  forbidden: SafeShareForbiddenEntities,
): GameState {
  const state = structuredClone(input);
  state.meta.sourceCatalogPresent = options.includeSourceMetadata;
  if (options.safeShareMode === "strip_sealed_notes" || options.safeShareMode === "safe_share") {
    state.hidden.internalNotes = [];
    state.hidden.undiscoveredInformation = {};
  }
  if (options.safeShareMode === "safe_share") {
    const filterIds = (ids: string[]): string[] => filterPolymorphicIds(ids, forbidden, "source");
    for (const meetingId of forbidden.meetingIds) delete state.meetings[meetingId];
    state.meta.sourceIds = filterIds(state.meta.sourceIds);
    state.country.sourceIds = filterIds(state.country.sourceIds);
    for (const character of Object.values(state.characters)) {
      character.sourceIds = filterIds(character.sourceIds);
    }
    for (const office of Object.values(state.offices))
      office.sourceIds = filterIds(office.sourceIds);
    for (const region of Object.values(state.regions))
      region.sourceIds = filterIds(region.sourceIds);
    for (const meeting of Object.values(state.meetings)) {
      meeting.participantIds = meeting.participantIds.filter(
        (id) => !isUnsafeTypedReference(forbidden, GAME_STATE_MEETING_PARTICIPANT_ENTITY_SET, id),
      );
      meeting.sourceIds = filterIds(meeting.sourceIds);
    }
    for (const modifier of Object.values(state.modifiers)) {
      modifier.sourceIds = filterIds(modifier.sourceIds);
    }
    for (const policy of Object.values(state.policies)) {
      policy.sourceIds = filterIds(policy.sourceIds);
      if (
        policy.origin.kind === "meeting" &&
        (forbidden.meetingIds.has(policy.origin.meetingId) ||
          forbidden.outcomeIds.has(policy.origin.outcomeCandidateId))
      ) {
        policy.origin = { kind: "redacted" };
      }
    }
    state.eventQueue.pendingEventIds = state.eventQueue.pendingEventIds.filter(
      (id) => !forbidden.eventIds.has(id),
    );
    state.eventQueue.processedEventIds = state.eventQueue.processedEventIds.filter(
      (id) => !forbidden.eventIds.has(id),
    );
    state.hidden = {
      queuedEventIds: [],
      secretFlags: {},
      internalNotes: [],
      undiscoveredInformation: {},
      policyTruth: {},
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
  forbidden: SafeShareForbiddenEntities,
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
    const shouldFlatten = !options.includeSourceMetadata || options.safeShareMode !== "none";
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
      // 安全分享：sealed 记忆与 sealed/private 会议内容属于绝不出境的私密数据（ADR-012/018/021）
      database
        .prepare(
          `DELETE FROM character_memories
           WHERE visibility IN ('private', 'sealed')
              OR source_meeting_id IN (
                SELECT meeting_id FROM meeting_sessions
                WHERE save_id = ? AND (visibility = 'sealed' OR type = 'secret-council')
              )`,
        )
        .run(saveId);
      const dropIfExists = (sql: string) => {
        try {
          database.prepare(sql).run();
        } catch {
          // 旧版数据库无会议表时忽略
        }
      };
      dropIfExists("DELETE FROM meeting_turns WHERE visibility IN ('sealed', 'private')");
      dropIfExists(
        "DELETE FROM character_conversation_turns WHERE mode IN ('private-audience', 'secret-council')",
      );
      dropIfExists("DELETE FROM meeting_minutes WHERE kind = 'private'");
      dropIfExists("DELETE FROM meeting_leak_assessments");
      dropIfExists("DELETE FROM meeting_leak_assessment_versions");
      dropIfExists(
        "DELETE FROM meeting_sessions WHERE visibility = 'sealed' OR type = 'secret-council'",
      );
      // Phase 5：真实执行明细（偏差/系数分解/内档奏报）绝不出境（ADR-025）；
      // hidden.policyTruth 已随 state.hidden 清空
      dropIfExists("DELETE FROM policy_deviation_log");
      dropIfExists("DELETE FROM policy_stage_results");
      dropIfExists("DELETE FROM policy_cost_applications");
      dropIfExists("DELETE FROM policy_reports WHERE audience = 'hidden'");
      const deleteByIds = (table: string, column: string, ids: ReadonlySet<string>): void => {
        if (ids.size === 0) return;
        const values = [...ids];
        try {
          database
            .prepare(
              `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IN (${values.map(() => "?").join(", ")})`,
            )
            .run(...values);
        } catch {
          // 旧版数据库无对应表时忽略。
        }
      };
      for (const [table, column, ids] of [
        ["meeting_rulings", "ruling_id", forbidden.rulingIds],
        ["meeting_outcome_candidates", "outcome_candidate_id", forbidden.outcomeIds],
        ["meeting_turns", "turn_id", forbidden.turnIds],
        ["meeting_minutes", "minutes_id", forbidden.minutesIds],
        ["meeting_agenda_items", "agenda_item_id", forbidden.agendaIds],
        ["character_memories", "memory_id", forbidden.memoryIds],
        ["character_conversation_turns", "turn_id", forbidden.conversationTurnIds],
        ["meeting_outcome_candidate_versions", "outcome_candidate_id", forbidden.outcomeIds],
        ["meeting_sessions", "meeting_id", forbidden.sessionIds],
      ] as const) {
        deleteByIds(table, column, ids);
      }
      sanitizeKnownDatabaseReferences(database, forbidden);
      assertNoForbiddenStructuredReferences(database, forbidden);
    }
    const title =
      options.safeShareMode === "safe_share" ? redactSensitiveString(row.title) : row.title;
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
    const sourceState = repository.loadHeadState(saveId);
    const forbidden =
      options.safeShareMode === "safe_share"
        ? collectSafeShareForbiddenIds(sourceDatabase, saveId, sourceState)
        : createForbiddenEntities();
    const state = sanitizeState(sourceState, options, forbidden);
    await backup(sourceDatabase, path);
    copy = new DatabaseSync(path, { allowExtension: false });
    updateExportCopy(copy, state, saveId, options, clock, forbidden);
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
