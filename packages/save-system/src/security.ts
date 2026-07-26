import { sha256Hex } from "@mandate/game-engine";

const SENSITIVE_PATTERNS = [
  /sk-[a-z0-9_-]{6,}/gi,
  /authorization\s*:\s*bearer\s+[^\s"']+/gi,
  /\b(?:database_password|llm_api_key|api_key|password|token)\s*=\s*[^\s,;}"']+/gi,
] as const;

export function redactSensitiveString(value: string): string {
  return SENSITIVE_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, (match) => `[REDACTED:${sha256Hex(match).slice(0, 12)}]`),
    value,
  );
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitiveValue(item)]),
    ) as T;
  }
  return value;
}
