import {
  GameCommandSchema,
  GameStateSchema,
  SaveRollbackCommandSchema,
  type CharacterAssignOfficeCommand,
  type CountryAdjustResourceCommand,
  type GameCommand,
  type GameState,
  type ProposedMutation,
  type SaveRollbackCommand,
  type TimeAdvanceCommand,
} from "@mandate/domain";
import type { Clock } from "./clock";
import { SystemClock } from "./clock";
import { StateEngineError } from "./errors";
import {
  planMeetingCancel,
  planMeetingConclude,
  planMeetingCreate,
  planMeetingStart,
} from "./meeting-commands";
import { applyMutations, invertMutation, validateMutatedState } from "./mutation";
import { createDeterministicRandomSource, type RandomSource } from "./rng";
import { hashState } from "./stable-json";

export interface TimeAdvanceContext {
  readonly state: Readonly<GameState>;
  readonly command: TimeAdvanceCommand;
  readonly random: RandomSource;
  readonly clock: Clock;
}

export interface TimeAdvanceHook {
  onBeforeAdvance?(context: TimeAdvanceContext): readonly ProposedMutation[];
  onAfterAdvance?(context: TimeAdvanceContext): readonly ProposedMutation[];
}

export interface StateEngineOptions {
  clock?: Clock;
  timeAdvanceHooks?: readonly TimeAdvanceHook[];
}

export interface StateTransition {
  nextState: GameState;
  mutations: readonly ProposedMutation[];
  inverseMutations: readonly ProposedMutation[];
  beforeHash: string;
  afterHash: string;
  rngCursorBefore: number;
  rngCursorAfter: number;
}

function mutation(
  input: Omit<ProposedMutation, "sourceIds" | "visibility"> &
    Partial<Pick<ProposedMutation, "sourceIds" | "visibility">>,
): ProposedMutation {
  return {
    ...input,
    sourceIds: input.sourceIds ?? [],
    visibility: input.visibility ?? "internal",
  };
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function planResourceAdjustment(
  state: GameState,
  command: CountryAdjustResourceCommand,
): ProposedMutation[] {
  const resource = command.payload.resource;
  const before = state.country[resource];
  const after = before + command.payload.delta;
  return [
    mutation({
      aggregateType: "country",
      operation: command.payload.delta > 0 ? "increment" : "decrement",
      path: `/country/${resource}`,
      before,
      after,
      reason: command.payload.reason,
      sourceIds: command.payload.sourceIds ?? [],
      visibility: "public",
      tags: ["resource"],
    }),
  ];
}

function planOfficeAssignment(
  state: GameState,
  command: CharacterAssignOfficeCommand,
): ProposedMutation[] {
  const character = state.characters[command.payload.characterId];
  if (!character) {
    throw new StateEngineError("CHARACTER_NOT_FOUND", `人物不存在：${command.payload.characterId}`);
  }
  const targetOffice = command.payload.officeId
    ? state.offices[command.payload.officeId]
    : undefined;
  if (command.payload.officeId && !targetOffice) {
    throw new StateEngineError("OFFICE_NOT_FOUND", `官职不存在：${command.payload.officeId}`);
  }
  if (
    targetOffice?.holderCharacterId &&
    targetOffice.holderCharacterId !== command.payload.characterId
  ) {
    throw new StateEngineError("OFFICE_OCCUPIED", `官职已有人任职：${command.payload.officeId}`);
  }

  const sourceIds = command.payload.sourceIds ?? [];
  const mutations: ProposedMutation[] = [];
  if (character.officeId && character.officeId !== command.payload.officeId) {
    const previousOffice = state.offices[character.officeId];
    if (previousOffice) {
      mutations.push(
        mutation({
          aggregateType: "office",
          entityId: previousOffice.officeId,
          operation: "set",
          path: `/offices/${previousOffice.officeId}/holderCharacterId`,
          before: previousOffice.holderCharacterId,
          after: null,
          reason: command.payload.reason,
          sourceIds,
        }),
      );
    }
  }
  if (character.officeId !== command.payload.officeId) {
    mutations.push(
      mutation({
        aggregateType: "character",
        entityId: character.characterId,
        operation: "set",
        path: `/characters/${character.characterId}/officeId`,
        before: character.officeId,
        after: command.payload.officeId,
        reason: command.payload.reason,
        sourceIds,
        visibility: "public",
      }),
    );
  }
  if (targetOffice?.holderCharacterId !== command.payload.characterId && targetOffice) {
    mutations.push(
      mutation({
        aggregateType: "office",
        entityId: targetOffice.officeId,
        operation: "set",
        path: `/offices/${targetOffice.officeId}/holderCharacterId`,
        before: targetOffice.holderCharacterId,
        after: character.characterId,
        reason: command.payload.reason,
        sourceIds,
        visibility: "public",
      }),
      mutation({
        aggregateType: "office",
        entityId: targetOffice.officeId,
        operation: "set",
        path: `/offices/${targetOffice.officeId}/appointedAtRevision`,
        before: targetOffice.appointedAtRevision,
        after: state.revision + 1,
        reason: command.payload.reason,
        sourceIds,
      }),
    );
  }
  mutations.push(
    mutation({
      aggregateType: "character",
      entityId: character.characterId,
      operation: "set",
      path: `/characters/${character.characterId}/lastUpdatedRevision`,
      before: character.lastUpdatedRevision,
      after: state.revision + 1,
      sourceIds,
    }),
  );
  return mutations;
}

export class StateEngine {
  private readonly clock: Clock;
  private readonly timeAdvanceHooks: readonly TimeAdvanceHook[];

  constructor(options: StateEngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.timeAdvanceHooks = options.timeAdvanceHooks ?? [];
  }

  applyCommand(inputState: Readonly<GameState>, inputCommand: GameCommand): StateTransition {
    const stateResult = GameStateSchema.safeParse(inputState);
    if (!stateResult.success) {
      throw new StateEngineError(
        "STATE_VALIDATION_FAILED",
        "当前 GameState 无效",
        stateResult.error.issues,
      );
    }
    const commandResult = GameCommandSchema.safeParse(inputCommand);
    if (!commandResult.success) {
      throw new StateEngineError("COMMAND_INVALID", "Command Schema 校验失败", commandResult.error.issues);
    }
    const state = stateResult.data;
    const command = commandResult.data;
    if (command.saveId !== state.saveId) {
      throw new StateEngineError("STATE_SAVE_MISMATCH", "Command saveId 与 GameState 不一致");
    }
    if (command.baseRevision !== state.revision) {
      throw new StateEngineError(
        "STATE_REVISION_CONFLICT",
        `revision 冲突：期望 ${state.revision}，收到 ${command.baseRevision}`,
      );
    }

    const random = createDeterministicRandomSource(state.rng.seed, state.rng.cursor);
    const mutations: ProposedMutation[] = [];
    if (command.commandType === "country.adjust-resource") {
      mutations.push(...planResourceAdjustment(state, command));
    } else if (command.commandType === "character.assign-office") {
      mutations.push(...planOfficeAssignment(state, command));
    } else if (command.commandType === "time.advance") {
      const context: TimeAdvanceContext = { state, command, random, clock: this.clock };
      for (const hook of this.timeAdvanceHooks) {
        mutations.push(...(hook.onBeforeAdvance?.(context) ?? []));
      }
      mutations.push(
        mutation({
          aggregateType: "time",
          operation: "set",
          path: "/currentDate",
          before: state.currentDate,
          after: addDays(state.currentDate, command.payload.days),
          visibility: "public",
          tags: ["time"],
        }),
        mutation({
          aggregateType: "time",
          operation: "increment",
          path: "/tick",
          before: state.tick,
          after: state.tick + command.payload.days,
          visibility: "public",
          tags: ["time"],
        }),
      );
      for (const hook of this.timeAdvanceHooks) {
        mutations.push(...(hook.onAfterAdvance?.(context) ?? []));
      }
    } else if (command.commandType === "meeting.create") {
      mutations.push(...planMeetingCreate(state, command));
    } else if (command.commandType === "meeting.start") {
      mutations.push(...planMeetingStart(state, command));
    } else if (command.commandType === "meeting.conclude") {
      mutations.push(...planMeetingConclude(state, command));
    } else if (command.commandType === "meeting.cancel") {
      mutations.push(...planMeetingCancel(state, command));
    } else {
      throw new StateEngineError(
        "COMMAND_NOT_SUPPORTED",
        `命令 ${command.commandType} 不属于普通世界状态变更`,
      );
    }

    if (random.getCursor() !== state.rng.cursor) {
      mutations.push(
        mutation({
          aggregateType: "rng",
          operation: "set",
          path: "/rng/cursor",
          before: state.rng.cursor,
          after: random.getCursor(),
          tags: ["rng"],
        }),
      );
    }
    mutations.push(
      mutation({
        aggregateType: "state",
        operation: "increment",
        path: "/revision",
        before: state.revision,
        after: state.revision + 1,
        tags: ["revision"],
      }),
    );
    const updatedAt = this.clock.now().toISOString();
    if (updatedAt !== state.meta.updatedAt) {
      mutations.push(
        mutation({
          aggregateType: "state",
          operation: "set",
          path: "/meta/updatedAt",
          before: state.meta.updatedAt,
          after: updatedAt,
          tags: ["metadata"],
        }),
      );
    }

    const nextState = validateMutatedState(applyMutations(state, mutations));
    return {
      nextState,
      mutations,
      inverseMutations: [...mutations].reverse().map(invertMutation),
      beforeHash: hashState(state),
      afterHash: hashState(nextState),
      rngCursorBefore: state.rng.cursor,
      rngCursorAfter: nextState.rng.cursor,
    };
  }

  applyRollback(
    inputState: Readonly<GameState>,
    inputTargetState: Readonly<GameState>,
    inputCommand: SaveRollbackCommand,
  ): StateTransition {
    const stateResult = GameStateSchema.safeParse(inputState);
    const targetResult = GameStateSchema.safeParse(inputTargetState);
    const commandResult = SaveRollbackCommandSchema.safeParse(inputCommand);
    if (!stateResult.success || !targetResult.success) {
      throw new StateEngineError("STATE_VALIDATION_FAILED", "回滚状态无效", {
        current: stateResult.success ? [] : stateResult.error.issues,
        target: targetResult.success ? [] : targetResult.error.issues,
      });
    }
    if (!commandResult.success) {
      throw new StateEngineError("COMMAND_INVALID", "回滚 Command Schema 校验失败", commandResult.error.issues);
    }
    const state = stateResult.data;
    const target = targetResult.data;
    const command = commandResult.data;
    if (command.saveId !== state.saveId || target.saveId !== state.saveId) {
      throw new StateEngineError("STATE_SAVE_MISMATCH", "回滚状态不属于同一存档");
    }
    if (command.baseRevision !== state.revision) {
      throw new StateEngineError(
        "STATE_REVISION_CONFLICT",
        `revision 冲突：期望 ${state.revision}，收到 ${command.baseRevision}`,
      );
    }
    if (command.payload.targetRevision !== target.revision) {
      throw new StateEngineError("COMMAND_INVALID", "回滚目标 revision 与目标状态不一致");
    }

    const fields = [
      "currentDate",
      "tick",
      "rng",
      "country",
      "characters",
      "offices",
      "policies",
      "regions",
      "meetings",
      "eventQueue",
      "flags",
      "hidden",
    ] as const;
    const mutations: ProposedMutation[] = [];
    for (const field of fields) {
      if (hashState(state[field]) === hashState(target[field])) continue;
      mutations.push(
        mutation({
          aggregateType: "rollback",
          operation: "set",
          path: `/${field}`,
          before: state[field],
          after: target[field],
          reason: `逻辑回滚到 revision ${target.revision}`,
          sourceIds: target.meta.sourceIds,
          visibility: field === "hidden" ? "sealed" : "internal",
          tags: ["rollback", `target-${target.revision}`],
        }),
      );
    }
    if (hashState(state.meta.sourceIds) !== hashState(target.meta.sourceIds)) {
      mutations.push(
        mutation({
          aggregateType: "rollback",
          operation: "set",
          path: "/meta/sourceIds",
          before: state.meta.sourceIds,
          after: target.meta.sourceIds,
          reason: `逻辑回滚到 revision ${target.revision}`,
          sourceIds: target.meta.sourceIds,
          tags: ["rollback", `target-${target.revision}`],
        }),
      );
    }
    if (state.meta.sourceCatalogPresent !== target.meta.sourceCatalogPresent) {
      mutations.push(
        mutation({
          aggregateType: "rollback",
          operation: "set",
          path: "/meta/sourceCatalogPresent",
          before: state.meta.sourceCatalogPresent,
          after: target.meta.sourceCatalogPresent,
          reason: `逻辑回滚到 revision ${target.revision}`,
          sourceIds: target.meta.sourceIds,
          tags: ["rollback", `target-${target.revision}`],
        }),
      );
    }
    mutations.push(
      mutation({
        aggregateType: "state",
        operation: "increment",
        path: "/revision",
        before: state.revision,
        after: state.revision + 1,
        reason: `逻辑回滚到 revision ${target.revision}`,
        sourceIds: target.meta.sourceIds,
        tags: ["rollback", `target-${target.revision}`, "revision"],
      }),
    );
    const updatedAt = this.clock.now().toISOString();
    if (updatedAt !== state.meta.updatedAt) {
      mutations.push(
        mutation({
          aggregateType: "state",
          operation: "set",
          path: "/meta/updatedAt",
          before: state.meta.updatedAt,
          after: updatedAt,
          sourceIds: target.meta.sourceIds,
          tags: ["rollback", `target-${target.revision}`, "metadata"],
        }),
      );
    }
    const nextState = validateMutatedState(applyMutations(state, mutations));
    return {
      nextState,
      mutations,
      inverseMutations: [...mutations].reverse().map(invertMutation),
      beforeHash: hashState(state),
      afterHash: hashState(nextState),
      rngCursorBefore: state.rng.cursor,
      rngCursorAfter: nextState.rng.cursor,
    };
  }
}
