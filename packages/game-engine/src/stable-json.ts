import { createHash } from "node:crypto";

function normalize(value: unknown, inArray = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("稳定序列化不接受非有限数字");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) {
    if (inArray) throw new TypeError("稳定序列化不接受数组中的 undefined");
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, true));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = normalize(record[key]);
      if (item !== undefined) normalized[key] = item;
    }
    return normalized;
  }
  throw new TypeError(`稳定序列化不接受 ${typeof value}`);
}

export function stableStringify(value: unknown): string {
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new TypeError("值不可稳定序列化");
  return result;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashState(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
