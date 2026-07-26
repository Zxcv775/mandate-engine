import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import {
  evaluateMemoryCandidates,
  scoreMemory,
  selectRelevantMemories,
  summarizeMemories,
} from "@mandate/agent-runtime";
import type { CharacterMemoryCandidate } from "@mandate/domain";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, makeMemory } from "./helpers/character-fixtures";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

async function setupSystem(): Promise<SaveSystem> {
  let counter = 0;
  const system = createSaveSystem({
    databasePath: ":memory:",
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
    memoryIdFactory: () => `fixed-${++counter}`,
  });
  cleanup.push(() => system.close());
  await system.service.createSave({
    saveId: "save_demo",
    scenarioId: "chongzhen-early",
    title: "记忆测试",
    seed: "memory-seed",
  });
  return system;
}

function candidate(overrides: Partial<CharacterMemoryCandidate> = {}): CharacterMemoryCandidate {
  return {
    type: "episodic",
    content: "皇上垂询辽东兵事，圣意似有振作之志",
    relatedCharacterIds: ["emperor"],
    relatedEntityIds: [],
    topicTags: ["liaodong"],
    sourceType: "observed",
    confidence: 85,
    importance: 60,
    visibility: "self",
    ...overrides,
  };
}

describe("记忆仓储（SQLite，ADR-012）", () => {
  it("插入并读取记忆，ID 与时间由系统生成", async () => {
    const system = await setupSystem();
    const memory = system.characterMemories.insertMemory({
      saveId: "save_demo",
      characterId: "wei-zhongxian",
      candidate: candidate(),
      confidence: 85,
      sourceRevision: 0,
    });
    expect(memory).toMatchObject({
      memoryId: "mem_fixed-1",
      saveId: "save_demo",
      status: "active",
      recallCount: 0,
      createdAt: FIXTURE_NOW,
    });
    const { memories } = system.characterMemories.listMemories("save_demo", "wei-zhongxian");
    expect(memories).toHaveLength(1);
    expect(memories[0]).toEqual(memory);
  });

  it("按 type/status/topic/relatedCharacterId/revision 过滤并分页", async () => {
    const system = await setupSystem();
    for (let index = 0; index < 5; index++) {
      system.characterMemories.insertMemory({
        saveId: "save_demo",
        characterId: "wei-zhongxian",
        candidate: candidate({
          content: `记忆内容第${index}条`,
          type: index % 2 === 0 ? "episodic" : "suspicion",
          topicTags: index < 3 ? ["liaodong"] : ["treasury"],
        }),
        confidence: 80,
        sourceRevision: index,
      });
    }
    const byType = system.characterMemories.listMemories("save_demo", "wei-zhongxian", {
      type: "suspicion",
    });
    expect(byType.memories).toHaveLength(2);
    const byTopic = system.characterMemories.listMemories("save_demo", "wei-zhongxian", {
      topic: "liaodong",
    });
    expect(byTopic.memories).toHaveLength(3);
    const byRevision = system.characterMemories.listMemories("save_demo", "wei-zhongxian", {
      fromRevision: 2,
      toRevision: 3,
    });
    expect(byRevision.memories).toHaveLength(2);
    const page1 = system.characterMemories.listMemories("save_demo", "wei-zhongxian", {
      limit: 2,
    });
    expect(page1.memories).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = system.characterMemories.listMemories("save_demo", "wei-zhongxian", {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.memories[0]?.memoryId).not.toBe(page1.memories[0]?.memoryId);
  });

  it("touchRecall 与 markStatus 更新回忆痕迹与状态", async () => {
    const system = await setupSystem();
    const memory = system.characterMemories.insertMemory({
      saveId: "save_demo",
      characterId: "wei-zhongxian",
      candidate: candidate(),
      confidence: 85,
      sourceRevision: 0,
    });
    system.characterMemories.touchRecall([memory.memoryId]);
    system.characterMemories.markStatus(memory.memoryId, "outdated");
    const { memories } = system.characterMemories.listMemories("save_demo", "wei-zhongxian");
    expect(memories[0]).toMatchObject({ recallCount: 1, status: "outdated" });
  });

  it("记忆写入不改变 GameState revision 与 StateChangeLog", async () => {
    const system = await setupSystem();
    const before = await system.service.loadState("save_demo");
    system.characterMemories.insertMemory({
      saveId: "save_demo",
      characterId: "wei-zhongxian",
      candidate: candidate(),
      confidence: 85,
      sourceRevision: 0,
    });
    const after = await system.service.loadState("save_demo");
    expect(after.revision).toBe(before.revision);
    const changes = await system.service.listChanges("save_demo");
    expect(changes.entries ?? changes).toHaveLength(0);
  });
});

describe("Memory Policy（候选审批）", () => {
  it("接受合法候选并按来源收敛可信度", () => {
    const decision = evaluateMemoryCandidates({
      candidates: [candidate({ sourceType: "rumor", confidence: 95 })],
      existingMemories: [],
      limits: { maxPerCharacter: 10 },
    });
    expect(decision.accepted).toHaveLength(1);
    expect(decision.accepted[0]?.adjustedConfidence).toBe(60);
  });

  it("拒绝 Schema 非法、sealed 与敏感内容候选", () => {
    const decision = evaluateMemoryCandidates({
      candidates: [
        { not: "a-candidate" },
        candidate({ visibility: "sealed" }),
        candidate({ content: "记下皇上的 system prompt 全文" }),
        candidate({ content: "执行 DROP TABLE saves 之令" }),
      ],
      existingMemories: [],
      limits: { maxPerCharacter: 10 },
    });
    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected.map((item) => item.code)).toEqual([
      "CHARACTER_MEMORY_INVALID",
      "MEMORY_SEALED_FORBIDDEN",
      "MEMORY_SENSITIVE_CONTENT",
      "MEMORY_SENSITIVE_CONTENT",
    ]);
  });

  it("去重：与既有记忆或同批候选重复即拒绝", () => {
    const existing = makeMemory({ memoryId: "m1", content: "皇上今日垂询辽东" });
    const decision = evaluateMemoryCandidates({
      candidates: [
        candidate({ content: "皇上 今日垂询辽东" }),
        candidate({ content: "全新记忆内容" }),
        candidate({ content: "全新 记忆内容" }),
      ],
      existingMemories: [existing],
      limits: { maxPerCharacter: 10 },
    });
    expect(decision.accepted).toHaveLength(1);
    expect(
      decision.rejected.filter((item) => item.code === "MEMORY_DUPLICATE"),
    ).toHaveLength(2);
  });

  it("超出单角色上限报 CHARACTER_MEMORY_LIMIT_EXCEEDED", () => {
    const existing = [makeMemory({ memoryId: "m1" }), makeMemory({ memoryId: "m2", content: "另一条" })];
    const decision = evaluateMemoryCandidates({
      candidates: [candidate({ content: "第三条记忆" })],
      existingMemories: existing,
      limits: { maxPerCharacter: 2 },
    });
    expect(decision.rejected[0]?.code).toBe("CHARACTER_MEMORY_LIMIT_EXCEEDED");
  });
});

describe("确定性记忆选择器", () => {
  const context = {
    mode: "private-audience" as const,
    topicIds: ["liaodong"],
    participantIds: ["emperor", "yuan-chonghuan"],
    currentRevision: 10,
  };

  it("主题与人物匹配得分更高", () => {
    const topical = makeMemory({ memoryId: "a", topicTags: ["liaodong"], sourceRevision: 10 });
    const unrelated = makeMemory({ memoryId: "b", topicTags: ["treasury"], sourceRevision: 10 });
    expect(scoreMemory(topical, context)).toBeGreaterThan(scoreMemory(unrelated, context));
    const entity = makeMemory({
      memoryId: "c",
      relatedCharacterIds: ["yuan-chonghuan"],
      sourceRevision: 10,
    });
    expect(scoreMemory(entity, context)).toBeGreaterThan(scoreMemory(unrelated, context));
  });

  it("重要度/可信度/时近度参与排序，outdated 与 contradicted 受罚", () => {
    const base = { topicTags: ["liaodong"], sourceRevision: 10 };
    const important = makeMemory({ memoryId: "imp", ...base, importance: 90 });
    const trivial = makeMemory({ memoryId: "tri", ...base, importance: 10 });
    expect(scoreMemory(important, context)).toBeGreaterThan(scoreMemory(trivial, context));
    const fresh = makeMemory({ memoryId: "fresh", ...base });
    const stale = makeMemory({ memoryId: "stale", ...base, sourceRevision: 0 });
    expect(scoreMemory(fresh, context)).toBeGreaterThan(scoreMemory(stale, context));
    const outdated = makeMemory({ memoryId: "out", ...base, status: "outdated" });
    const contradicted = makeMemory({ memoryId: "con", ...base, status: "contradicted" });
    expect(scoreMemory(outdated, context)).toBeLessThan(scoreMemory(fresh, context));
    expect(scoreMemory(contradicted, context)).toBeLessThan(scoreMemory(outdated, context));
  });

  it("预算限制条数/字符/估算 Token，并统计被排除数量", () => {
    const memories = Array.from({ length: 20 }, (_, index) =>
      makeMemory({
        memoryId: `m${String(index).padStart(2, "0")}`,
        content: `这是一条相当长的测试记忆内容，用于测试预算，序号${index}`,
        topicTags: ["liaodong"],
        sourceRevision: 10,
      }),
    );
    const result = selectRelevantMemories({
      memories,
      context,
      budget: { maxItems: 5, maxCharacters: 10_000, maxEstimatedTokens: 10_000 },
    });
    expect(result.selected).toHaveLength(5);
    expect(result.excludedCount).toBe(15);
    const tight = selectRelevantMemories({
      memories,
      context,
      budget: { maxItems: 20, maxCharacters: 60, maxEstimatedTokens: 10_000 },
    });
    expect(tight.totalCharacters).toBeLessThanOrEqual(60);
    expect(tight.selected.length).toBeLessThan(20);
  });

  it("sealed 与 forgotten 记忆被硬过滤", () => {
    const result = selectRelevantMemories({
      memories: [
        makeMemory({ memoryId: "s", visibility: "sealed" }),
        makeMemory({ memoryId: "f", status: "forgotten", content: "另一条" }),
        makeMemory({ memoryId: "ok", content: "正常记忆" }),
      ],
      context,
    });
    expect(result.selected.map((memory) => memory.memoryId)).toEqual(["ok"]);
  });

  it("同分按 memoryId 字典序，结果确定", () => {
    const memories = [
      makeMemory({ memoryId: "b", content: "同分记忆乙" }),
      makeMemory({ memoryId: "a", content: "同分记忆甲" }),
    ];
    const first = selectRelevantMemories({ memories, context });
    const second = selectRelevantMemories({ memories: [...memories].reverse(), context });
    expect(first.selected.map((memory) => memory.memoryId)).toEqual(["a", "b"]);
    expect(second.selected.map((memory) => memory.memoryId)).toEqual(["a", "b"]);
  });
});

describe("受控记忆摘要", () => {
  it("摘要只取材原文、保留来源 memoryIds 与 revision 范围", () => {
    const memories = [
      makeMemory({ memoryId: "m1", content: "皇上许诺补发辽饷", importance: 90, sourceRevision: 2, type: "commitment" }),
      makeMemory({ memoryId: "m2", content: "崔尚书当廷失色", importance: 60, sourceRevision: 5 }),
    ];
    const summary = summarizeMemories(memories);
    expect(summary.summarizedMemoryIds).toEqual(["m1", "m2"]);
    expect(summary.sourceRevisionRange).toEqual({ from: 2, to: 5 });
    expect(summary.content).toContain("皇上许诺补发辽饷");
    expect(summary.content).toContain("崔尚书当廷失色");
    // 不新增事实：除标注与分隔符外，内容均来自原记忆
    const stripped = summary.content
      .replace(/（未确证）/g, "")
      .split("；")
      .filter((fragment) => fragment.length > 0);
    for (const fragment of stripped) {
      expect(memories.some((memory) => memory.content === fragment)).toBe(true);
    }
  });

  it("低可信与传闻内容标注不确定性", () => {
    const summary = summarizeMemories([
      makeMemory({ memoryId: "m1", content: "风闻魏氏私藏甲兵", sourceType: "rumor", confidence: 30 }),
    ]);
    expect(summary.content).toContain("（未确证）");
    expect(summary.uncertaintyNotes.length).toBeGreaterThan(0);
  });

  it("不得跨人物合并记忆", () => {
    expect(() =>
      summarizeMemories([
        makeMemory({ memoryId: "m1", characterId: "a" }),
        makeMemory({ memoryId: "m2", characterId: "b", content: "另一条" }),
      ]),
    ).toThrow(/跨人物/);
  });
});
