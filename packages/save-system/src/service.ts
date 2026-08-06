import type { ScenarioLoader } from "@mandate/data-loader";
import {
  GAME_STATE_SCHEMA_VERSION,
  GAME_STATE_VERSION,
  GameCommandSchema,
  SaveMetadataSchema,
  SafeShareModeSchema,
  SaveExportManifestSchema,
  SaveRepairPlanSchema,
  type GameCommand,
  type GameState,
  type JsonValue,
  type ProposedMutation,
  type Rule,
  type SaveRollbackCommand,
  type SaveMetadata,
  type SaveValidationReport,
  type SafeShareMode,
  type SaveExportManifest,
  type SaveImportResult,
  type SaveRepairPlan,
  type SubmitCommandRequest,
  toPlayerStateView,
  type PlayerStateView,
} from "@mandate/domain";
import {
  StateEngine,
  StateEngineError,
  SystemClock,
  applyMutations,
  createInitialGameState,
  hashState,
  sha256Hex,
  stableStringify,
  type Clock,
  type PolicyCommandAssets,
} from "@mandate/game-engine";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ENGINE_INFO } from "@mandate/shared";
import { SaveSystemError } from "./errors";
import { importVerifiedPackage } from "./importer";
import { buildSavePackage, parseSavePackage } from "./package-format";
import { createExportPayload } from "./payload";
import { commandRequestHash, type SqliteSaveRepository } from "./repository";
import type { PolicyDetailRepository } from "./policy-repository";
import { redactSensitiveString, redactSensitiveValue } from "./security";
import {
  STATE_DOCUMENT_MIGRATIONS,
  migrateGameStateDocument,
  migrateStatePointer,
} from "./state-migrations";
import type { ChangeQuery, CheckpointInput, CommitResult } from "./types";
import { validateSave } from "./validation";
import { recordRollbackTimeline } from "./timeline";

export interface CreateSaveInput {
  scenarioId: string;
  title: string;
  seed: string;
  saveId?: string;
}

export interface GameStateServiceOptions {
  repository: SqliteSaveRepository;
  scenarioLoader: ScenarioLoader;
  clock?: Clock;
  stateEngine?: StateEngine;
  /** Phase 5：政策明细仓储（结算产物与状态变更同事务落库） */
  policyDetails?: PolicyDetailRepository;
}

export interface PreparedCommandTransition {
  command: GameCommand;
  transition: import("@mandate/game-engine").StateTransition;
}

export interface RollbackInput {
  targetRevision: number;
  dryRun?: boolean;
}

export interface RollbackResult {
  dryRun: boolean;
  currentRevision: number;
  targetRevision: number;
  resultRevision: number | null;
  mutationCount: number;
  paths: readonly string[];
  transaction?: CommitResult;
}

export interface ExportSaveOptions {
  includeSourceMetadata: boolean;
  safeShareMode: SafeShareMode;
  password?: string;
  exportedFromClientId?: string;
  outputPath?: string;
}

export interface ExportSaveResult {
  bytes: Uint8Array;
  manifest: SaveExportManifest;
  packageHash: string;
  outputPath?: string;
}

export interface ImportSaveInput {
  bytes: Uint8Array;
  password?: string;
  clientId?: string;
}

export interface RepairSaveInput {
  dryRun: boolean;
  allowHeadRebuild: boolean;
  allowIndexRebuild: boolean;
  allowSnapshotRebuild: boolean;
}

export interface AdvanceTimeInput {
  commandId: string;
  baseRevision: number;
  days: number;
  idempotencyKey?: string;
}

export interface MigrateSaveResult {
  saveId: string;
  fromVersion: number;
  toVersion: number;
  changed: boolean;
  appliedMigrationIds: readonly string[];
}

export class GameStateService {
  private readonly clock: Clock;
  private readonly stateEngine: StateEngine;

  constructor(private readonly options: GameStateServiceOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.stateEngine = options.stateEngine ?? new StateEngine({ clock: this.clock });
  }

  async createSave(input: CreateSaveInput): Promise<SaveMetadata> {
    const bundle = await this.options.scenarioLoader.loadScenarioBundle(input.scenarioId);
    const saveId = input.saveId ?? `save_${randomUUID()}`;
    const now = this.clock.now().toISOString();
    const state = createInitialGameState(bundle, { saveId, seed: input.seed }, this.clock);
    const metadata = SaveMetadataSchema.parse({
      saveId,
      scenarioId: bundle.scenario.id,
      dynastyId: bundle.dynasty.id,
      title: redactSensitiveString(input.title),
      status: "active",
      headRevision: 0,
      schemaVersion: GAME_STATE_SCHEMA_VERSION,
      stateVersion: GAME_STATE_VERSION,
      lineageId: `lineage_${randomUUID()}`,
      parentSaveId: null,
      sourceMetadataMode: "full",
      currentDate: state.currentDate,
      snapshotCount: 1,
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: now,
    });
    return this.options.repository.createSave({
      metadata,
      state,
      sourceCatalog: bundle.historicalSources,
    });
  }

  async listSaves(options?: { includeArchived?: boolean }): Promise<SaveMetadata[]> {
    return this.options.repository.listSaves(options);
  }

  async getSave(saveId: string): Promise<SaveMetadata> {
    const save = this.options.repository.getSave(saveId);
    if (!save) throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
    return save;
  }

  async loadState(saveId: string): Promise<GameState> {
    return this.options.repository.loadHeadState(saveId);
  }

  async loadPlayerState(saveId: string): Promise<PlayerStateView> {
    return toPlayerStateView(await this.loadState(saveId));
  }

  async listChanges(saveId: string, query: ChangeQuery = {}) {
    await this.getSave(saveId);
    return this.options.repository
      .loadChanges(saveId, query)
      .filter((entry) => entry.visibility !== "sealed");
  }

  async commitCommand(input: GameCommand): Promise<CommitResult> {
    const commandResult = GameCommandSchema.safeParse(input);
    if (!commandResult.success) {
      throw new SaveSystemError(
        "STATE_INVALID",
        "Command Schema 校验失败",
        commandResult.error.issues,
      );
    }
    const command = GameCommandSchema.parse(redactSensitiveValue(commandResult.data));
    if (command.idempotencyKey) {
      const prior = this.options.repository.findIdempotentResult(
        command.saveId,
        command.idempotencyKey,
        commandRequestHash(command),
      );
      if (prior) return prior;
    }
    const save = await this.getSave(command.saveId);
    if (save.headRevision !== command.baseRevision) {
      if (command.idempotencyKey) {
        const concurrentPrior = this.options.repository.findIdempotentResult(
          command.saveId,
          command.idempotencyKey,
          commandRequestHash(command),
        );
        if (concurrentPrior) return concurrentPrior;
      }
      throw new SaveSystemError(
        "STATE_REVISION_CONFLICT",
        `revision 冲突：期望 ${save.headRevision}，收到 ${command.baseRevision}`,
      );
    }
    const state = this.options.repository.loadHeadState(command.saveId);
    try {
      // Phase 5：政策命令与时间推进需要模板/规则资产（缓存的场景包，首次已在 createSave 加载）
      const needsPolicyAssets =
        command.commandType.startsWith("policy.") || command.commandType === "time.advance";
      const context = needsPolicyAssets
        ? { policyAssets: await this.loadPolicyAssets(save.scenarioId) }
        : {};
      const transition = this.stateEngine.applyCommand(state, command, context);
      const artifacts = transition.policyResolution;
      const policyDetails = this.options.policyDetails;
      return this.options.repository.commitTransition(
        command,
        transition,
        artifacts && policyDetails
          ? { extraWrites: () => policyDetails.insertResolutionArtifacts(artifacts) }
          : {},
      );
    } catch (error) {
      if (error instanceof StateEngineError) {
        if (error.code === "STATE_REVISION_CONFLICT") {
          if (command.idempotencyKey) {
            const concurrentPrior = this.options.repository.findIdempotentResult(
              command.saveId,
              command.idempotencyKey,
              commandRequestHash(command),
            );
            if (concurrentPrior) return concurrentPrior;
          }
          throw new SaveSystemError(error.code, error.message, error.details);
        }
        // Phase 4/5：会议与政策生命周期错误保留原码，供 API 层映射 404/409/422
        if (error.code.startsWith("MEETING_") || error.code.startsWith("POLICY_")) {
          throw new SaveSystemError(error.code as never, error.message, error.details);
        }
        throw new SaveSystemError("STATE_INVALID", error.message, error.details);
      }
      throw error;
    }
  }

  async prepareCommand(state: GameState, input: GameCommand): Promise<PreparedCommandTransition> {
    const parsed = GameCommandSchema.safeParse(input);
    if (!parsed.success) {
      throw new SaveSystemError("STATE_INVALID", "Command Schema 校验失败", parsed.error.issues);
    }
    const command = GameCommandSchema.parse(redactSensitiveValue(parsed.data));
    if (command.saveId !== state.saveId || command.baseRevision !== state.revision) {
      throw new SaveSystemError(
        "STATE_REVISION_CONFLICT",
        `预演 revision 冲突：期望 ${state.revision}，收到 ${command.baseRevision}`,
      );
    }
    try {
      const needsPolicyAssets =
        command.commandType.startsWith("policy.") || command.commandType === "time.advance";
      const context = needsPolicyAssets
        ? { policyAssets: await this.loadPolicyAssets(state.scenarioId) }
        : {};
      return { command, transition: this.stateEngine.applyCommand(state, command, context) };
    } catch (error) {
      if (error instanceof StateEngineError) {
        if (error.code === "STATE_REVISION_CONFLICT") {
          throw new SaveSystemError(error.code, error.message, error.details);
        }
        if (error.code.startsWith("MEETING_") || error.code.startsWith("POLICY_")) {
          throw new SaveSystemError(error.code as never, error.message, error.details);
        }
        throw new SaveSystemError("STATE_INVALID", error.message, error.details);
      }
      throw error;
    }
  }

  commitPreparedCommandsAtomically(
    prepared: readonly PreparedCommandTransition[],
    extraWrites?: (results: readonly CommitResult[]) => void,
  ): CommitResult[] {
    return this.options.repository.runInTransaction(() => {
      const results = prepared.map(({ command, transition }) => {
        const artifacts = transition.policyResolution;
        return this.options.repository.commitTransition(
          command,
          transition,
          artifacts && this.options.policyDetails
            ? {
                extraWrites: () => this.options.policyDetails?.insertResolutionArtifacts(artifacts),
              }
            : {},
        );
      });
      extraWrites?.(results);
      return results;
    });
  }

  async commitCommandsAtomically(
    inputs: readonly GameCommand[],
    extraWrites?: (results: readonly CommitResult[]) => void,
  ): Promise<CommitResult[]> {
    if (inputs.length === 0) {
      return this.commitPreparedCommandsAtomically([], extraWrites);
    }
    let state = this.options.repository.loadHeadState(inputs[0]!.saveId);
    const prepared: PreparedCommandTransition[] = [];
    for (const input of inputs) {
      const item = await this.prepareCommand(state, input);
      prepared.push(item);
      state = item.transition.nextState;
    }
    return this.commitPreparedCommandsAtomically(prepared, extraWrites);
  }

  private readonly policyAssetsCache = new Map<string, PolicyCommandAssets>();

  private async loadPolicyAssets(scenarioId: string): Promise<PolicyCommandAssets> {
    const cached = this.policyAssetsCache.get(scenarioId);
    if (cached) return cached;
    const bundle = await this.options.scenarioLoader.loadScenarioBundle(scenarioId);
    const assets: PolicyCommandAssets = {
      // 场景包为深冻结只读：克隆一份供引擎（引擎自身不修改，克隆仅为脱 DeepReadonly 类型）
      templates: structuredClone(
        bundle.policyTemplates,
      ) as unknown as PolicyCommandAssets["templates"],
      rules: (structuredClone(bundle.rulePacks) as unknown as { rules: Rule[] }[]).flatMap(
        (pack) => pack.rules,
      ),
      // 人物卡无 moralFlexibility 字段：以廉直（integrity）反相换算（ADR-025）
      characterMetrics: Object.fromEntries(
        bundle.characters.map((character) => [
          character.id,
          {
            moralFlexibility: 100 - character.personality.integrity,
            competence: character.competence.administration,
          },
        ]),
      ),
    };
    this.policyAssetsCache.set(scenarioId, assets);
    return assets;
  }

  async submitPlayerCommand(saveId: string, input: SubmitCommandRequest): Promise<CommitResult> {
    const command = GameCommandSchema.parse({
      ...input,
      saveId,
      actor: { type: "player", id: "player" },
      createdAt: this.clock.now().toISOString(),
    });
    return this.commitCommand(command);
  }

  async advanceTime(saveId: string, input: AdvanceTimeInput): Promise<CommitResult> {
    return this.commitCommand({
      commandId: input.commandId,
      commandType: "time.advance",
      saveId,
      baseRevision: input.baseRevision,
      actor: { type: "player", id: "player" },
      payload: { days: input.days },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: this.clock.now().toISOString(),
    });
  }

  async createCheckpoint(saveId: string, input: CheckpointInput) {
    return this.options.repository.createCheckpoint(saveId, input);
  }

  async archiveSave(saveId: string): Promise<void> {
    this.options.repository.archiveSave(saveId);
  }

  async validateSave(saveId: string): Promise<SaveValidationReport> {
    return validateSave(this.options.repository.database, this.options.repository, saveId);
  }

  async rollback(saveId: string, input: RollbackInput): Promise<RollbackResult> {
    const current = this.options.repository.loadHeadState(saveId);
    if (
      !Number.isInteger(input.targetRevision) ||
      input.targetRevision < 0 ||
      input.targetRevision >= current.revision
    ) {
      throw new SaveSystemError(
        "ROLLBACK_TARGET_INVALID",
        `回滚目标必须在 0..${Math.max(current.revision - 1, 0)} 之间`,
      );
    }
    const target = this.options.repository.loadStateAtRevision(saveId, input.targetRevision);
    const command: SaveRollbackCommand = {
      commandId: `cmd_rollback_${randomUUID()}`,
      commandType: "save.rollback",
      saveId,
      baseRevision: current.revision,
      actor: { type: "system", id: "save-service" },
      payload: {
        targetRevision: input.targetRevision,
        mode: "logical",
        dryRun: input.dryRun ?? false,
      },
      createdAt: this.clock.now().toISOString(),
    };
    const transition = this.stateEngine.applyRollback(current, target, command);
    const summary: RollbackResult = {
      dryRun: input.dryRun ?? false,
      currentRevision: current.revision,
      targetRevision: target.revision,
      resultRevision: input.dryRun ? null : transition.nextState.revision,
      mutationCount: transition.mutations.length,
      paths: transition.mutations.map((item) => item.path),
    };
    if (input.dryRun) return summary;

    const transaction = this.options.repository.commitTransition(command, transition, {
      preCommitCheckpoint: {
        kind: "manual",
        label: `pre-rollback:${input.targetRevision}`,
      },
      validateBeforeCommit: () => {
        const validation = validateSave(
          this.options.repository.database,
          this.options.repository,
          saveId,
        );
        if (!validation.valid) {
          throw new SaveSystemError("STATE_INVALID", "逻辑回滚后完整性校验失败", validation);
        }
      },
      extraWrites: () => {
        recordRollbackTimeline(this.options.repository.database, {
          saveId,
          targetRevision: input.targetRevision,
          resultRevision: transition.nextState.revision,
          createdAt: command.createdAt,
        });
      },
    });
    return { ...summary, transaction };
  }

  async exportSave(saveId: string, input: ExportSaveOptions): Promise<ExportSaveResult> {
    const safeShareMode = SafeShareModeSchema.parse(input.safeShareMode);
    const includeSourceMetadata =
      input.includeSourceMetadata &&
      safeShareMode !== "strip_source_catalog" &&
      safeShareMode !== "safe_share";
    const save = await this.getSave(saveId);
    const payload = await createExportPayload(
      this.options.repository.database,
      this.options.repository,
      saveId,
      { includeSourceMetadata, safeShareMode },
      this.clock,
    );
    const manifest = SaveExportManifestSchema.parse({
      exportFormatVersion: 1,
      appVersion: ENGINE_INFO.version,
      saveId: save.saveId,
      lineageId: save.lineageId,
      scenarioId: save.scenarioId,
      dynastyId: save.dynastyId,
      schemaVersion: save.schemaVersion,
      stateVersion: save.stateVersion,
      baseRevision: 0,
      headRevision: save.headRevision,
      exportedAt: this.clock.now().toISOString(),
      includeSourceMetadata,
      sourceMetadataMode: includeSourceMetadata ? "full" : "omit_catalog",
      encrypted: Boolean(input.password),
      safeShareMode,
      ...(input.exportedFromClientId ? { exportedFromClientId: input.exportedFromClientId } : {}),
    });
    const bytes = buildSavePackage(manifest, payload, input.password);
    const packageHash = sha256Hex(bytes);
    if (input.outputPath) await writeFile(input.outputPath, bytes);
    return {
      bytes,
      manifest,
      packageHash,
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    };
  }

  async importSave(input: ImportSaveInput): Promise<SaveImportResult> {
    const parsed = parseSavePackage(input.bytes, input.password);
    if (parsed.manifest.encrypted !== Boolean(input.password)) {
      throw new SaveSystemError("SAVE_PACKAGE_INVALID", "manifest 加密标记与存档包不一致");
    }
    return importVerifiedPackage(this.options.repository, parsed, this.clock, {
      ...(input.clientId ? { clientId: input.clientId } : {}),
    });
  }

  async repairSave(saveId: string, input: RepairSaveInput): Promise<SaveRepairPlan> {
    if (!input.dryRun) {
      throw new SaveSystemError(
        "REPAIR_EXECUTION_NOT_SUPPORTED",
        "Phase 2 仅开放可审计的 repair dry-run",
      );
    }
    const validation = await this.validateSave(saveId);
    const hasFailed = (code: string) =>
      validation.checks.some((item) => item.code === code && item.status === "failed");
    return SaveRepairPlanSchema.parse({
      saveId,
      dryRun: true,
      actions: [
        {
          code: "MARK_ORPHAN_PENDING_FAILED",
          description: "将可确定的孤立 pending transaction 标记为 failed",
          applicable: hasFailed("PENDING_TRANSACTIONS"),
        },
        {
          code: "REBUILD_HEAD_REVISION",
          description: "从可验证 transaction/snapshot 推导 headRevision",
          applicable: input.allowHeadRebuild && hasFailed("REVISION_CONTINUITY"),
        },
        {
          code: "REBUILD_INDEXES",
          description: "重建固定白名单索引",
          applicable: input.allowIndexRebuild && hasFailed("SQLITE_INTEGRITY"),
        },
        {
          code: "REBUILD_HEAD_SNAPSHOT",
          description: "从最近有效 snapshot 与日志生成新 snapshot",
          applicable: input.allowSnapshotRebuild && hasFailed("HEAD_REPLAY"),
        },
      ],
      validation,
    });
  }

  async migrateSave(saveId: string): Promise<MigrateSaveResult> {
    const database = this.options.repository.database;
    const save = database
      .prepare(
        "SELECT save_id, head_revision, state_version, metadata_json FROM saves WHERE save_id = ? AND status <> 'deleted'",
      )
      .get(saveId) as
      | { save_id: string; head_revision: number; state_version: number; metadata_json: string }
      | undefined;
    if (!save) throw new SaveSystemError("SAVE_NOT_FOUND", `存档不存在：${saveId}`);
    const fromVersion = Number(save.state_version);
    if (fromVersion > GAME_STATE_VERSION) {
      throw new SaveSystemError("SAVE_VERSION_UNSUPPORTED", "存档状态版本高于当前引擎");
    }
    if (fromVersion === GAME_STATE_VERSION) {
      return {
        saveId,
        fromVersion,
        toVersion: GAME_STATE_VERSION,
        changed: false,
        appliedMigrationIds: [],
      };
    }

    try {
      database.exec("BEGIN IMMEDIATE");
      const headRevision = Number(save.head_revision);
      const baseSnapshot = database
        .prepare(
          "SELECT snapshot_id, revision, state_json, state_hash FROM save_snapshots WHERE save_id = ? AND revision <= ? AND checkpoint_kind <> 'pre_migration' ORDER BY revision DESC LIMIT 1",
        )
        .get(saveId, headRevision) as
        | { snapshot_id: string; revision: number; state_json: string; state_hash: string }
        | undefined;
      if (!baseSnapshot) throw new Error("旧存档缺少可迁移 snapshot");
      const rawBase = JSON.parse(baseSnapshot.state_json) as Record<string, unknown>;
      if (hashState(rawBase) !== baseSnapshot.state_hash) {
        throw new Error("旧存档 snapshot hash 不匹配");
      }
      const rawLogRows = database
        .prepare(
          `SELECT aggregate_type, entity_id, operation, path, diff_json,
                  source_ids_json, tags_json, visibility
             FROM state_change_log
            WHERE save_id = ? AND revision > ? AND revision <= ?
            ORDER BY revision, sequence`,
        )
        .all(saveId, Number(baseSnapshot.revision), headRevision) as Array<{
        aggregate_type: string;
        entity_id: string | null;
        operation: ProposedMutation["operation"];
        path: string;
        diff_json: string;
        source_ids_json: string;
        tags_json: string;
        visibility: ProposedMutation["visibility"];
      }>;
      const rawMutations: ProposedMutation[] = rawLogRows.map((row) => {
        const diff = JSON.parse(row.diff_json) as {
          before: JsonValue;
          after: JsonValue;
          reason?: string;
        };
        return {
          aggregateType: row.aggregate_type,
          ...(row.entity_id ? { entityId: row.entity_id } : {}),
          operation: row.operation,
          path: row.path,
          before: diff.before,
          after: diff.after,
          ...(diff.reason ? { reason: diff.reason } : {}),
          sourceIds: JSON.parse(row.source_ids_json) as string[],
          tags: JSON.parse(row.tags_json) as string[],
          visibility: row.visibility,
        };
      });
      const rawHead = applyMutations(
        rawBase as unknown as GameState,
        rawMutations,
      ) as unknown as Record<string, unknown>;
      const headMigration = migrateGameStateDocument(rawHead);
      const backupSnapshotId = `snapshot_pre_migration_${randomUUID()}`;
      const now = this.clock.now().toISOString();
      database
        .prepare(
          `INSERT INTO save_snapshots (
             snapshot_id, save_id, revision, checkpoint_kind, label,
             state_json, state_hash, created_at
           ) VALUES (?, ?, ?, 'pre_migration', ?, ?, ?, ?)`,
        )
        .run(
          backupSnapshotId,
          saveId,
          headRevision,
          `state-version-${fromVersion}`,
          stableStringify(rawHead),
          hashState(rawHead),
          now,
        );

      const snapshots = database
        .prepare(
          "SELECT snapshot_id, state_json FROM save_snapshots WHERE save_id = ? AND checkpoint_kind <> 'pre_migration'",
        )
        .all(saveId) as Array<{ snapshot_id: string; state_json: string }>;
      const updateSnapshot = database.prepare(
        "UPDATE save_snapshots SET state_json = ?, state_hash = ? WHERE snapshot_id = ?",
      );
      for (const snapshot of snapshots) {
        const migrated = migrateGameStateDocument(JSON.parse(snapshot.state_json));
        updateSnapshot.run(
          stableStringify(migrated.state),
          hashState(migrated.state),
          snapshot.snapshot_id,
        );
      }

      const logPaths = database
        .prepare("SELECT log_id, path, inverse_diff_json FROM state_change_log WHERE save_id = ?")
        .all(saveId) as Array<{
        log_id: string;
        path: string;
        inverse_diff_json: string | null;
      }>;
      const updateLogPath = database.prepare(
        "UPDATE state_change_log SET path = ?, inverse_diff_json = ? WHERE log_id = ?",
      );
      for (const row of logPaths) {
        const path = migrateStatePointer(row.path, headMigration.appliedMigrationIds);
        let inverse = row.inverse_diff_json;
        if (inverse) {
          const document = JSON.parse(inverse) as Record<string, unknown>;
          if (typeof document.path === "string") {
            document.path = migrateStatePointer(document.path, headMigration.appliedMigrationIds);
          }
          inverse = stableStringify(document);
        }
        updateLogPath.run(path, inverse, row.log_id);
      }

      const metadata = JSON.parse(save.metadata_json) as Record<string, unknown>;
      delete metadata.headStateHash;
      database
        .prepare(
          "UPDATE saves SET state_version = ?, metadata_json = ?, updated_at = ? WHERE save_id = ?",
        )
        .run(GAME_STATE_VERSION, stableStringify(metadata), now, saveId);

      let previousHash: string | null = null;
      const migratedEntries = this.options.repository.loadChanges(saveId, 0);
      const revisionHashes = new Map<number, string>();
      const revisionHash = (revision: number) => {
        const cached = revisionHashes.get(revision);
        if (cached) return cached;
        const value = hashState(this.options.repository.loadStateAtRevision(saveId, revision));
        revisionHashes.set(revision, value);
        return value;
      };
      const updateLogHash = database.prepare(
        "UPDATE state_change_log SET before_hash = ?, after_hash = ?, prev_log_hash = ?, entry_hash = ? WHERE log_id = ?",
      );
      for (const entry of migratedEntries) {
        const beforeHash = entry.sequence === 0 ? revisionHash(entry.revision - 1) : null;
        const afterHash = revisionHash(entry.revision);
        const normalized = {
          ...entry,
          ...(beforeHash ? { beforeHash } : { beforeHash: undefined }),
          afterHash,
          prevLogHash: previousHash,
        } as Record<string, unknown>;
        delete normalized.entryHash;
        if (normalized.beforeHash === undefined) delete normalized.beforeHash;
        const entryHash = sha256Hex(stableStringify(normalized));
        updateLogHash.run(beforeHash, afterHash, previousHash, entryHash, entry.logId);
        previousHash = entryHash;
      }

      const migratedHead = this.options.repository.loadStateAtRevision(saveId, headRevision);
      metadata.headStateHash = hashState(migratedHead);
      metadata.appliedStateMigrations = headMigration.appliedMigrationIds;
      database
        .prepare("UPDATE saves SET metadata_json = ? WHERE save_id = ?")
        .run(stableStringify(metadata), saveId);
      const insertMigration = database.prepare(
        `INSERT INTO save_state_migrations (
           save_id, migration_id, checksum, from_version, to_version,
           backup_snapshot_id, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const migrationId of headMigration.appliedMigrationIds) {
        const migration = STATE_DOCUMENT_MIGRATIONS.find((item) => item.id === migrationId);
        if (!migration) throw new Error(`未知状态迁移：${migrationId}`);
        insertMigration.run(
          saveId,
          migration.id,
          migration.checksum,
          migration.fromVersion,
          migration.toVersion,
          backupSnapshotId,
          now,
        );
      }
      const validation = validateSave(database, this.options.repository, saveId);
      if (!validation.valid) throw new Error("迁移后存档完整性校验失败");
      database.exec("COMMIT");
      return {
        saveId,
        fromVersion,
        toVersion: GAME_STATE_VERSION,
        changed: true,
        appliedMigrationIds: headMigration.appliedMigrationIds,
      };
    } catch {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw new SaveSystemError("MIGRATION_FAILED", "存档前向迁移失败，事务已回滚");
    }
  }
}
