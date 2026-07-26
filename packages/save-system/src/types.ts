import type {
  CheckpointKind,
  CheckpointMetadata,
  GameCommand,
  GameState,
  HistoricalSource,
  SaveMetadata,
  StateChangeLogEntry,
} from "@mandate/domain";

export type CommitFailureStage =
  "after_transaction" | "after_logs" | "after_head" | "after_checkpoint";

export interface RepositoryOptions {
  checkpointInterval: number;
  failureInjector?: (stage: CommitFailureStage) => void;
}

export interface CreateSaveRecordInput {
  metadata: SaveMetadata;
  state: GameState;
  sourceCatalog?: readonly HistoricalSource[];
}

export interface CommitResult {
  txId: string;
  revision: number;
  stateHash: string;
  mutationCount: number;
  idempotent: boolean;
}

export interface CommitTransitionOptions {
  preCommitCheckpoint?: CheckpointInput;
  validateBeforeCommit?: () => void;
  /** Phase 5：与状态变更同事务的附加写入（政策明细/奏报等 append-only 表） */
  extraWrites?: () => void;
}

export interface CheckpointInput {
  kind: CheckpointKind;
  label?: string;
}

export interface ChangeQuery {
  fromRevision?: number;
  toRevision?: number;
  commandType?: string;
  actorType?: string;
  aggregateType?: string;
  entityId?: string;
  visibility?: "public" | "internal" | "sealed";
  limit?: number;
  cursor?: number;
}

export interface RowCounts {
  saves: number;
  transactions: number;
  snapshots: number;
  logs: number;
}

export interface SaveRepositoryContract {
  createSave(input: CreateSaveRecordInput): SaveMetadata;
  listSaves(options?: { includeArchived?: boolean }): SaveMetadata[];
  getSave(saveId: string): SaveMetadata | null;
  archiveSave(saveId: string): void;
  loadHeadState(saveId: string): GameState;
  loadStateAtRevision(saveId: string, revision: number): GameState;
  loadChanges(saveId: string, fromRevision?: number, toRevision?: number): StateChangeLogEntry[];
  createCheckpoint(saveId: string, input: CheckpointInput): CheckpointMetadata;
  findIdempotentResult(saveId: string, idempotencyKey: string): CommitResult | null;
  commitTransition(
    command: GameCommand,
    transition: import("@mandate/game-engine").StateTransition,
    options?: CommitTransitionOptions,
  ): CommitResult;
}
