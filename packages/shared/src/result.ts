/**
 * 统一结果类型：用于不抛异常的可预期失败路径。
 * 意外错误（bug、LLM 输出非法等）仍使用异常。
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
