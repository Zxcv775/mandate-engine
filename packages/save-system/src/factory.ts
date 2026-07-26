import { createScenarioLoader, type ScenarioLoader } from "@mandate/data-loader";
import { StateEngine, SystemClock, type Clock } from "@mandate/game-engine";
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openSaveDatabase } from "./database";
import { CharacterMemoryRepository } from "./character-memory-repository";
import { MeetingRepository } from "./meeting-repository";
import { PolicyDetailRepository } from "./policy-repository";
import { SqliteSaveRepository } from "./repository";
import { GameStateService } from "./service";
import type { CommitFailureStage } from "./types";

export interface CreateSaveSystemOptions {
  databasePath: string;
  scenarioLoader?: ScenarioLoader;
  clock?: Clock;
  checkpointInterval?: number;
  stateEngine?: StateEngine;
  failureInjector?: (stage: CommitFailureStage) => void;
  wal?: boolean;
  /** 记忆/对话 ID 生成器（测试注入确定性 ID 用） */
  memoryIdFactory?: () => string;
}

export interface SaveSystem {
  database: DatabaseSync;
  repository: SqliteSaveRepository;
  service: GameStateService;
  characterMemories: CharacterMemoryRepository;
  meetings: MeetingRepository;
  policyDetails: PolicyDetailRepository;
  close(): void;
}

export function createSaveSystem(options: CreateSaveSystemOptions): SaveSystem {
  const clock = options.clock ?? new SystemClock();
  const checkpointInterval = options.checkpointInterval ?? 50;
  if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
    throw new Error("checkpointInterval 必须是正整数");
  }
  if (options.databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(options.databasePath)), { recursive: true });
  }
  const database = openSaveDatabase(options.databasePath, { clock, wal: options.wal });
  const repository = new SqliteSaveRepository(database, clock, {
    checkpointInterval,
    ...(options.failureInjector ? { failureInjector: options.failureInjector } : {}),
  });
  const policyDetails = new PolicyDetailRepository(database, clock);
  const service = new GameStateService({
    repository,
    scenarioLoader: options.scenarioLoader ?? createScenarioLoader(),
    clock,
    stateEngine: options.stateEngine ?? new StateEngine({ clock }),
    policyDetails,
  });
  const characterMemories = options.memoryIdFactory
    ? new CharacterMemoryRepository(database, clock, options.memoryIdFactory)
    : new CharacterMemoryRepository(database, clock);
  const meetings = new MeetingRepository(database, clock);
  return {
    database,
    repository,
    service,
    characterMemories,
    meetings,
    policyDetails,
    close: () => database.close(),
  };
}
