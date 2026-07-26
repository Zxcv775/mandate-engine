import {
  CharacterMemoryCandidateSchema,
  type CharacterMemory,
  type CharacterMemoryCandidate,
} from "@mandate/domain";

/**
 * Memory Policy（ADR-012）：Agent 产出的记忆候选必须经本策略审批，
 * 候选必须可被拒绝；Agent 自身没有任何记忆持久化权限。
 * 规则全部确定性，逐条给出拒绝原因码，便于审计与测试。
 */

export type MemoryRejectionCode =
  | "CHARACTER_MEMORY_INVALID"
  | "MEMORY_SEALED_FORBIDDEN"
  | "MEMORY_SENSITIVE_CONTENT"
  | "MEMORY_DUPLICATE"
  | "CHARACTER_MEMORY_LIMIT_EXCEEDED";

export interface RejectedMemoryCandidate {
  readonly candidate: unknown;
  readonly code: MemoryRejectionCode;
  readonly message: string;
}

export interface AcceptedMemoryCandidate {
  readonly candidate: CharacterMemoryCandidate;
  /** 策略收敛后的可信度（如谣言封顶），落库以此为准 */
  readonly adjustedConfidence: number;
}

export interface MemoryPolicyInput {
  readonly candidates: readonly unknown[];
  /** 该角色现存（未遗忘）记忆，用于去重与限额 */
  readonly existingMemories: readonly CharacterMemory[];
  readonly limits: { readonly maxPerCharacter: number };
}

export interface MemoryPolicyDecision {
  readonly accepted: readonly AcceptedMemoryCandidate[];
  readonly rejected: readonly RejectedMemoryCandidate[];
}

/** 记忆内容中绝不允许出现的敏感模式：系统边界、隐藏状态与凭据痕迹 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /api[-_\s]?key/i,
  /authorization/i,
  /system\s*prompt/i,
  /系统提示词/,
  /<\/?(?:character-data|known-world-state|character-memories|conversation-input)>/i,
  /secretFlags/i,
  /undiscoveredInformation/i,
  /internalNotes/i,
  /\bhidden\s*state\b/i,
  /\b(?:DROP|DELETE|UPDATE|INSERT)\s+(?:TABLE|FROM|INTO|saves)\b/i,
];

/** 按来源类型收敛可信度上限：角色不能给道听途说标记为确凿 */
const CONFIDENCE_CAPS: Readonly<Record<CharacterMemoryCandidate["sourceType"], number>> = {
  observed: 100,
  told: 90,
  "official-record": 95,
  rumor: 60,
  inference: 70,
  "agent-generated-summary": 80,
};

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, "").toLowerCase();
}

export function evaluateMemoryCandidates(input: MemoryPolicyInput): MemoryPolicyDecision {
  const accepted: AcceptedMemoryCandidate[] = [];
  const rejected: RejectedMemoryCandidate[] = [];
  const seenContents = new Set(
    input.existingMemories
      .filter((memory) => memory.status !== "forgotten")
      .map((memory) => normalizeContent(memory.content)),
  );
  const activeCount = input.existingMemories.filter(
    (memory) => memory.status !== "forgotten",
  ).length;

  for (const raw of input.candidates) {
    const parsed = CharacterMemoryCandidateSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({
        candidate: raw,
        code: "CHARACTER_MEMORY_INVALID",
        message: "记忆候选未通过 Schema 校验",
      });
      continue;
    }
    const candidate = parsed.data;
    if (candidate.visibility === "sealed") {
      rejected.push({
        candidate,
        code: "MEMORY_SEALED_FORBIDDEN",
        message: "Agent 不得自行产生 sealed 记忆",
      });
      continue;
    }
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(candidate.content))) {
      rejected.push({
        candidate,
        code: "MEMORY_SENSITIVE_CONTENT",
        message: "记忆内容包含系统边界或敏感模式",
      });
      continue;
    }
    const normalized = normalizeContent(candidate.content);
    if (seenContents.has(normalized)) {
      rejected.push({
        candidate,
        code: "MEMORY_DUPLICATE",
        message: "与既有记忆或本批候选重复",
      });
      continue;
    }
    if (activeCount + accepted.length >= input.limits.maxPerCharacter) {
      rejected.push({
        candidate,
        code: "CHARACTER_MEMORY_LIMIT_EXCEEDED",
        message: `角色记忆数量已达上限 ${input.limits.maxPerCharacter}`,
      });
      continue;
    }
    seenContents.add(normalized);
    accepted.push({
      candidate,
      adjustedConfidence: Math.min(candidate.confidence, CONFIDENCE_CAPS[candidate.sourceType]),
    });
  }

  return { accepted, rejected };
}
