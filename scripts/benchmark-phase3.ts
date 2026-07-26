import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, createInitialGameState } from "@mandate/game-engine";
import {
  CharacterAgent,
  CharacterContextBuilder,
  buildCharacterView,
  createCharacterMockProvider,
  selectRelevantMemories,
} from "@mandate/agent-runtime";
import { composeCharacterPrompt } from "@mandate/prompt-system";
import { createSaveSystem } from "@mandate/save-system";
import type { CharacterMemory, CharacterTemplate, Institution, Office } from "@mandate/domain";

/**
 * Phase 3 性能基准（§21）：Character View / Memory Selector / Prompt Composer /
 * Mock Agent 全链耗时与记忆库增长。全部离线，Mock Provider。
 */

const NOW = "2026-07-26T00:00:00.000Z";
const ITERATIONS = 50;

function measure(
  label: string,
  iterations: number,
  fn: () => void,
): { label: string; avgMs: number } {
  fn(); // 预热
  const started = performance.now();
  for (let index = 0; index < iterations; index++) fn();
  const avgMs = (performance.now() - started) / iterations;
  return { label, avgMs: Number(avgMs.toFixed(3)) };
}

async function measureAsync(
  label: string,
  iterations: number,
  fn: () => Promise<unknown>,
): Promise<{ label: string; avgMs: number }> {
  await fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) await fn();
  const avgMs = (performance.now() - started) / iterations;
  return { label, avgMs: Number(avgMs.toFixed(3)) };
}

function makeMemories(count: number): CharacterMemory[] {
  return Array.from({ length: count }, (_, index) => ({
    memoryId: `mem-${String(index).padStart(4, "0")}`,
    saveId: "save_bench",
    characterId: "wei-zhongxian",
    type: index % 3 === 0 ? "episodic" : index % 3 === 1 ? "semantic" : "suspicion",
    content: `基准测试记忆第 ${index} 条：辽东军情、粮饷度支与厂卫奏报的例行记闻。`,
    relatedCharacterIds: index % 4 === 0 ? ["emperor"] : [],
    relatedEntityIds: [],
    topicTags: index % 2 === 0 ? ["liaodong"] : ["treasury"],
    sourceRevision: index % 20,
    sourceType: "observed",
    confidence: 50 + (index % 50),
    importance: index % 100,
    visibility: "self",
    status: index % 17 === 0 ? "outdated" : "active",
    createdAt: NOW,
    recallCount: 0,
  }));
}

async function main(): Promise<void> {
  const clock = new FixedClock(NOW);
  const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
  const templates = {
    scenarioName: bundle.scenario.name,
    characters: structuredClone(bundle.characters) as CharacterTemplate[],
    offices: structuredClone(bundle.offices) as Office[],
    institutions: structuredClone(bundle.institutions) as Institution[],
  };
  const state = createInitialGameState(
    {
      scenario: bundle.scenario,
      dynasty: bundle.dynasty,
      characters: bundle.characters,
      institutions: bundle.institutions,
      offices: bundle.offices,
      historicalSources: bundle.historicalSources,
    },
    { saveId: "save_bench", seed: "bench-seed" },
    clock,
  );

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    iterations: ITERATIONS,
  };

  // 1. Character View 构建
  results.characterViewBuild = measure("character-view-build", ITERATIONS, () => {
    buildCharacterView({
      state,
      characterId: "wei-zhongxian",
      context: { mode: "private-audience", participantIds: ["emperor", "wei-zhongxian"] },
      memories: [],
      templates,
    });
  });

  // 2. Memory Selector（100 / 1000 条）
  const memories100 = makeMemories(100);
  const memories1000 = makeMemories(1_000);
  const selectionContext = {
    mode: "private-audience" as const,
    topicIds: ["liaodong"],
    participantIds: ["emperor", "wei-zhongxian"],
    currentRevision: 20,
  };
  results.memorySelector100 = measure("memory-selector-100", ITERATIONS, () => {
    selectRelevantMemories({ memories: memories100, context: selectionContext });
  });
  results.memorySelector1000 = measure("memory-selector-1000", ITERATIONS, () => {
    selectRelevantMemories({ memories: memories1000, context: selectionContext });
  });

  // 3. Prompt Composition
  const template = templates.characters.find((value) => value.id === "wei-zhongxian")!;
  const selection = selectRelevantMemories({ memories: memories100, context: selectionContext });
  const view = buildCharacterView({
    state,
    characterId: "wei-zhongxian",
    context: { mode: "private-audience", participantIds: ["emperor", "wei-zhongxian"] },
    memories: selection.selected,
    templates,
  });
  const composeInput = {
    scenarioName: bundle.scenario.name,
    template,
    view,
    mode: "private-audience" as const,
    topic: "liaodong",
    participants: [
      { id: "emperor", name: "皇帝" },
      { id: "wei-zhongxian", name: "魏忠贤" },
    ],
    previousTurns: [],
    input: { speakerId: "emperor", speakerLabel: "皇帝", text: "厂卫近报可有欺瞒？" },
  };
  results.promptComposition = await measureAsync("prompt-composition", ITERATIONS, () =>
    composeCharacterPrompt(composeInput),
  );
  const composed = await composeCharacterPrompt(composeInput);
  results.promptSize = {
    characters: composed.budget.totalCharacters,
    estimatedTokens: composed.budget.totalEstimatedTokens,
    segments: composed.budget.segments.length,
  };

  // 4. Mock Agent 完整调用
  const contextBuilder = new CharacterContextBuilder(
    {
      loadHeadState: () => structuredClone(state),
      listMemories: () => memories100,
      listRecentTurns: () => [],
    },
    templates,
  );
  const agent = new CharacterAgent(
    contextBuilder,
    createCharacterMockProvider(
      { defaultStance: "support" },
      Object.fromEntries(templates.characters.map((value) => [value.id, value.name])),
    ),
    { clock },
  );
  results.mockAgentRespond = await measureAsync("mock-agent-respond", 20, () =>
    agent.respond({
      saveId: "save_bench",
      characterId: "wei-zhongxian",
      mode: "private-audience",
      input: { speakerId: "emperor", text: "厂卫近报可有欺瞒？" },
      expectedRevision: 0,
    }),
  );

  // 5. 记忆数据库增长
  const directory = await mkdtemp(join(tmpdir(), "mandate-phase3-bench-"));
  try {
    const databasePath = join(directory, "bench.sqlite");
    const system = createSaveSystem({
      databasePath,
      scenarioLoader: createScenarioLoader(),
      clock,
    });
    await system.service.createSave({
      saveId: "save_bench",
      scenarioId: "chongzhen-early",
      title: "基准",
      seed: "bench-seed",
    });
    const sizeBefore = (await stat(databasePath)).size;
    const insertStart = performance.now();
    for (const memory of makeMemories(1_000)) {
      system.characterMemories.insertMemory({
        saveId: "save_bench",
        characterId: memory.characterId,
        candidate: {
          type: memory.type,
          content: memory.content,
          relatedCharacterIds: memory.relatedCharacterIds,
          relatedEntityIds: memory.relatedEntityIds,
          topicTags: memory.topicTags,
          sourceType: memory.sourceType,
          confidence: memory.confidence,
          importance: memory.importance,
          visibility: memory.visibility,
        },
        confidence: memory.confidence,
        sourceRevision: memory.sourceRevision,
      });
    }
    const insertMs = performance.now() - insertStart;
    system.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const sizeAfter = (await stat(databasePath)).size;
    system.close();
    results.memoryDatabase = {
      insertedRows: 1_000,
      insertTotalMs: Number(insertMs.toFixed(1)),
      bytesBefore: sizeBefore,
      bytesAfter: sizeAfter,
      bytesPerMemory: Number(((sizeAfter - sizeBefore) / 1_000).toFixed(1)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const outputPath = fileURLToPath(
    new URL("../docs/progress/phase3-benchmark.json", import.meta.url),
  );
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
  console.log(`基准结果已写入 docs/progress/phase3-benchmark.json`);
}

await main();
