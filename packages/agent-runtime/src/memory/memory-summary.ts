import {
  MEMORY_CONTENT_MAX_LENGTH,
  MemorySummarySchema,
  type CharacterMemory,
  type MemorySummary,
} from "@mandate/domain";

/**
 * 受控记忆摘要（ADR-012）。
 * 纯规则拼接：只从原记忆内容中取材，不经 LLM，不新增任何事实；
 * 保留被压缩 memoryIds 与来源 revision 范围；低可信/推断内容显式标注不确定性。
 */

export interface SummarizeMemoriesOptions {
  /** 最多纳入的记忆条数（按重要度降序），默认 6 */
  readonly maxSourceItems?: number;
}

export function summarizeMemories(
  memories: readonly CharacterMemory[],
  options: SummarizeMemoriesOptions = {},
): MemorySummary {
  if (memories.length === 0) {
    throw new Error("摘要至少需要一条记忆");
  }
  const characterIds = new Set(memories.map((memory) => memory.characterId));
  if (characterIds.size > 1) {
    throw new Error("不得跨人物合并记忆摘要");
  }

  const maxSourceItems = options.maxSourceItems ?? 6;
  const ranked = [...memories].sort(
    (a, b) => b.importance - a.importance || a.memoryId.localeCompare(b.memoryId),
  );
  const included = ranked.slice(0, maxSourceItems);

  const fragments: string[] = [];
  const uncertaintyNotes: string[] = [];
  let length = 0;
  for (const memory of included) {
    const uncertain =
      memory.confidence < 50 ||
      memory.sourceType === "rumor" ||
      memory.sourceType === "inference" ||
      memory.type === "suspicion";
    const fragment = uncertain ? `（未确证）${memory.content}` : memory.content;
    // 预留分隔符长度；超出单条记忆长度上限则停止收录，绝不截断句中内容以免歪曲原意
    if (length + fragment.length + 1 > MEMORY_CONTENT_MAX_LENGTH) break;
    fragments.push(fragment);
    length += fragment.length + 1;
    if (uncertain) {
      uncertaintyNotes.push(
        `「${memory.content.slice(0, 20)}…」为${sourceLabel(memory)}，未经确证`,
      );
    }
  }
  if (fragments.length === 0) {
    // 单条已超预算：直接引用最重要一条的截断前缀，并标注截断
    const first = included[0]!;
    fragments.push(first.content.slice(0, MEMORY_CONTENT_MAX_LENGTH - 10));
    uncertaintyNotes.push("原记忆过长，摘要仅保留开头部分");
  }

  const revisions = included.map((memory) => memory.sourceRevision);
  return MemorySummarySchema.parse({
    content: fragments.join("；"),
    summarizedMemoryIds: included.map((memory) => memory.memoryId),
    sourceRevisionRange: {
      from: Math.min(...revisions),
      to: Math.max(...revisions),
    },
    uncertaintyNotes,
  });
}

function sourceLabel(memory: CharacterMemory): string {
  switch (memory.sourceType) {
    case "rumor":
      return "传闻";
    case "inference":
      return "推断";
    case "told":
      return "他人转述";
    default:
      return "存疑记闻";
  }
}
