import {
  GameStateSchema,
  ProposedMutationSchema,
  type GameState,
  type ProposedMutation,
} from "@mandate/domain";
import { StateEngineError } from "./errors";
import { stableStringify } from "./stable-json";

const forbiddenSegments = new Set(["__proto__", "prototype", "constructor"]);

function decodePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") {
    throw new StateEngineError("MUTATION_PATH_INVALID", `Mutation path 无效：${path}`);
  }
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => segment.length === 0 || forbiddenSegments.has(segment))) {
    throw new StateEngineError("MUTATION_PATH_INVALID", `Mutation path 含禁止字段：${path}`);
  }
  return segments;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function parentAtPath(root: Record<string, unknown>, segments: readonly string[]) {
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== "object") {
      throw new StateEngineError("MUTATION_PATH_INVALID", "Mutation path 穿过非对象值");
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      throw new StateEngineError("MUTATION_PATH_INVALID", `Mutation path 不存在：${segment}`);
    }
    current = record[segment];
  }
  if (current === null || typeof current !== "object") {
    throw new StateEngineError("MUTATION_PATH_INVALID", "Mutation path 父级不是对象");
  }
  return current as Record<string, unknown>;
}

/** 在已克隆的可变根上原地应用一条 mutation（校验语义与克隆版一致） */
function applyMutationInPlace(root: Record<string, unknown>, input: ProposedMutation): void {
  const mutation = ProposedMutationSchema.parse(input);
  const segments = decodePointer(mutation.path);
  const parent = parentAtPath(root, segments);
  const key = segments.at(-1) as string;
  const exists = Object.prototype.hasOwnProperty.call(parent, key);

  // Phase 4：add/remove 获得逐键语义（新增/删除 record 条目），与 inverse 定义对称
  if (mutation.operation === "add") {
    if (exists) {
      throw new StateEngineError("MUTATION_PATH_INVALID", `add 目标已存在：${mutation.path}`);
    }
    if (mutation.before !== null) {
      throw new StateEngineError(
        "MUTATION_BEFORE_MISMATCH",
        `add 的 before 必须为 null：${mutation.path}`,
      );
    }
    parent[key] = structuredClone(mutation.after);
    return;
  }
  if (mutation.operation === "remove") {
    if (!exists) {
      throw new StateEngineError("MUTATION_PATH_INVALID", `remove 目标不存在：${mutation.path}`);
    }
    if (!sameValue(parent[key], mutation.before)) {
      throw new StateEngineError(
        "MUTATION_BEFORE_MISMATCH",
        `Mutation before 与当前值不一致：${mutation.path}`,
      );
    }
    if (mutation.after !== null) {
      throw new StateEngineError(
        "MUTATION_BEFORE_MISMATCH",
        `remove 的 after 必须为 null：${mutation.path}`,
      );
    }
    delete parent[key];
    return;
  }

  if (!exists) {
    throw new StateEngineError("MUTATION_PATH_INVALID", `Mutation path 不存在：${mutation.path}`);
  }
  if (!sameValue(parent[key], mutation.before)) {
    throw new StateEngineError(
      "MUTATION_BEFORE_MISMATCH",
      `Mutation before 与当前值不一致：${mutation.path}`,
    );
  }
  parent[key] = structuredClone(mutation.after);
}

export function applyMutation(state: Readonly<GameState>, input: ProposedMutation): GameState {
  return applyMutations(state, [input]);
}

/**
 * 批量应用：整体只克隆一次（Phase 5 性能修正——此前每条 mutation 全量克隆状态，
 * 政策结算的多 mutation 事务呈 O(mutations × stateSize)）。失败时抛错、
 * 调用方丢弃返回值即可，语义与逐条克隆版一致。
 */
export function applyMutations(
  state: Readonly<GameState>,
  mutations: readonly ProposedMutation[],
): GameState {
  const next = structuredClone(state) as unknown as Record<string, unknown>;
  for (const mutation of mutations) {
    applyMutationInPlace(next, mutation);
  }
  return next as unknown as GameState;
}

/**
 * 引擎内部：在调用方持有的可变草稿上原地批量应用（政策结算的草稿推进用）。
 * 注意：失败时草稿可能已被部分修改——仅可用于"失败即整体丢弃草稿"的场景。
 */
export function applyMutationsInPlaceUnsafe(
  draftRoot: Record<string, unknown>,
  mutations: readonly ProposedMutation[],
): void {
  for (const mutation of mutations) {
    applyMutationInPlace(draftRoot, mutation);
  }
}

const inverseOperations = {
  set: "set",
  add: "remove",
  remove: "add",
  increment: "decrement",
  decrement: "increment",
  patch: "set",
} as const;

export function invertMutation(mutation: ProposedMutation): ProposedMutation {
  const parsed = ProposedMutationSchema.parse(mutation);
  return {
    ...parsed,
    operation: inverseOperations[parsed.operation],
    before: structuredClone(parsed.after),
    after: structuredClone(parsed.before),
    tags: [...(parsed.tags ?? []), "inverse"],
  };
}

export function validateMutatedState(state: unknown): GameState {
  const result = GameStateSchema.safeParse(state);
  if (!result.success) {
    throw new StateEngineError(
      "STATE_VALIDATION_FAILED",
      "变更后的 GameState 无效",
      result.error.issues,
    );
  }
  return result.data;
}
