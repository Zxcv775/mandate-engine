import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, createInitialGameState, hashState } from "@mandate/game-engine";
import {
  CharacterAgent,
  CharacterContextBuilder,
  MOCK_INVALID_JSON_TEXT,
  MOCK_SCHEMA_ERROR_TEXT,
  buildMockCharacterOutput,
  createCharacterMockProvider,
  evaluateCharacterConsistency,
} from "@mandate/agent-runtime";
import { LLMProviderError, MockLLMProvider } from "@mandate/llm-adapters";
import type {
  CharacterAgentRequest,
  CharacterTemplate,
  GameState,
  Institution,
  Office,
} from "@mandate/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_NOW, makeCharacterTemplate } from "./helpers/character-fixtures";

/** 使用真实 chongzhen-early 场景数据 + Mock Provider 的 Agent 行为测试（零网络）。 */

const clock = new FixedClock(FIXTURE_NOW);
let baseState: GameState;
let templates: {
  scenarioName: string;
  characters: CharacterTemplate[];
  offices: Office[];
  institutions: Institution[];
};
let characterNames: Record<string, string>;

beforeAll(async () => {
  const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
  templates = {
    scenarioName: bundle.scenario.name,
    characters: structuredClone(bundle.characters) as CharacterTemplate[],
    offices: structuredClone(bundle.offices) as Office[],
    institutions: structuredClone(bundle.institutions) as Institution[],
  };
  baseState = createInitialGameState(
    {
      scenario: bundle.scenario,
      dynasty: bundle.dynasty,
      characters: bundle.characters,
      institutions: bundle.institutions,
      offices: bundle.offices,
      historicalSources: bundle.historicalSources,
    },
    { saveId: "save_agent", seed: "agent-seed" },
    clock,
  );
  characterNames = Object.fromEntries(templates.characters.map((value) => [value.id, value.name]));
});

function makeAgent(provider: MockLLMProvider, maxRepairAttempts = 1) {
  const builder = new CharacterContextBuilder(
    {
      loadHeadState: () => structuredClone(baseState),
      listMemories: () => [],
      listRecentTurns: () => [],
    },
    templates,
  );
  return new CharacterAgent(builder, provider, { maxRepairAttempts, clock });
}

function request(overrides: Partial<CharacterAgentRequest> = {}): CharacterAgentRequest {
  return {
    saveId: "save_agent",
    characterId: "wei-zhongxian",
    mode: "private-audience",
    input: { speakerId: "emperor", text: "厂卫近报可有欺瞒？" },
    expectedRevision: 0,
    ...overrides,
  };
}

describe("单人物 Character Agent（ADR-014）", () => {
  it.each([
    ["support", "support"],
    ["oppose", "oppose"],
    ["evasive", "evasive"],
    ["uncertain", "uncertain"],
  ] as const)("Mock %s 立场产生结构化响应", async (fixture, position) => {
    const agent = makeAgent(
      createCharacterMockProvider({ defaultStance: fixture }, characterNames),
    );
    const { result, consistency } = await agent.respond(request());
    expect(result.stance.position).toBe(position);
    expect(result.speech.length).toBeGreaterThan(0);
    expect(result.characterId).toBe("wei-zhongxian");
    expect(result.trace).toMatchObject({
      provider: "mock",
      stateRevision: 0,
      repaired: false,
    });
    expect(consistency.passed).toBe(true);
  });

  it("不同场合同一人物：表达不同、核心立场不反转", async () => {
    const provider = createCharacterMockProvider({ defaultStance: "oppose" }, characterNames);
    const agent = makeAgent(provider);
    const privateAudience = await agent.respond(request());
    const court = await agent.respond(request({ mode: "court-assembly" }));
    expect(privateAudience.result.speech).not.toBe(court.result.speech);
    expect(privateAudience.result.stance.position).toBe(court.result.stance.position);
  });

  it("按人物路由不同立场", async () => {
    const provider = createCharacterMockProvider(
      { defaultStance: "support", byCharacterId: { "wei-zhongxian": "evasive" } },
      characterNames,
    );
    const agent = makeAgent(provider);
    const wei = await agent.respond(request());
    const huang = await agent.respond(request({ characterId: "huang-liji" }));
    expect(wei.result.stance.position).toBe("evasive");
    expect(huang.result.stance.position).toBe("support");
  });

  it("首次输出非法 JSON → 一次修复成功（repaired=true）", async () => {
    const provider = createCharacterMockProvider(
      { firstCallInvalid: "invalid-json", defaultStance: "support" },
      characterNames,
    );
    const agent = makeAgent(provider);
    const { result } = await agent.respond(request());
    expect(result.trace.repaired).toBe(true);
    expect(provider.calls).toHaveLength(2);
    // 修复请求只包含契约与原输出，不重发完整人物上下文
    const repairMessages = provider.calls[1]!;
    expect(repairMessages.map((m) => m.content).join("\n")).toContain("结构化输出修复");
    expect(repairMessages.map((m) => m.content).join("\n")).not.toContain("人物身份");
  });

  it("首次输出 Schema 错误 → 修复成功", async () => {
    const provider = createCharacterMockProvider(
      { firstCallInvalid: "schema-error", defaultStance: "support" },
      characterNames,
    );
    const agent = makeAgent(provider);
    const { result } = await agent.respond(request());
    expect(result.trace.repaired).toBe(true);
  });

  it("修复后仍非法 → LLM_OUTPUT_REPAIR_FAILED，且不超过修复上限", async () => {
    const provider = createCharacterMockProvider({ alwaysInvalid: "schema-error" }, characterNames);
    const agent = makeAgent(provider, 1);
    await expect(agent.respond(request())).rejects.toMatchObject({
      code: "LLM_OUTPUT_REPAIR_FAILED",
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("禁用修复（maxRepairAttempts=0）时首败即 CHARACTER_OUTPUT_INVALID", async () => {
    const provider = createCharacterMockProvider({ alwaysInvalid: "invalid-json" }, characterNames);
    const agent = makeAgent(provider, 0);
    await expect(agent.respond(request())).rejects.toMatchObject({
      code: "CHARACTER_OUTPUT_INVALID",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("Provider 超时与不可用向上抛 LLMProviderError", async () => {
    const timeoutAgent = makeAgent(
      createCharacterMockProvider({ alwaysFail: "timeout" }, characterNames),
    );
    await expect(timeoutAgent.respond(request())).rejects.toThrowError(LLMProviderError);
    const downAgent = makeAgent(
      createCharacterMockProvider({ alwaysFail: "unavailable" }, characterNames),
    );
    await expect(downAgent.respond(request())).rejects.toThrowError(LLMProviderError);
  });

  it("revision 过期 → CHARACTER_CONTEXT_STALE，不悄悄用新状态", async () => {
    const agent = makeAgent(createCharacterMockProvider({}, characterNames));
    await expect(agent.respond(request({ expectedRevision: 3 }))).rejects.toMatchObject({
      code: "CHARACTER_CONTEXT_STALE",
    });
  });

  it("人物不存在 → CHARACTER_NOT_FOUND", async () => {
    const agent = makeAgent(createCharacterMockProvider({}, characterNames));
    await expect(agent.respond(request({ characterId: "nobody" }))).rejects.toMatchObject({
      code: "CHARACTER_NOT_FOUND",
    });
  });

  it("去职人物不可交谈 → CHARACTER_NOT_AVAILABLE（袁崇焕开局在籍）", async () => {
    const agent = makeAgent(createCharacterMockProvider({}, characterNames));
    await expect(agent.respond(request({ characterId: "yuan-chonghuan" }))).rejects.toMatchObject({
      code: "CHARACTER_NOT_AVAILABLE",
    });
  });

  it("Agent 调用不修改 GameState：hash 与 revision 不变，候选行动只是建议", async () => {
    const before = hashState(baseState);
    const agent = makeAgent(
      createCharacterMockProvider({ defaultStance: "support" }, characterNames),
    );
    const { result } = await agent.respond(request());
    expect(result.proposedActions.length).toBeGreaterThan(0);
    expect(hashState(baseState)).toBe(before);
    expect(baseState.revision).toBe(0);
  });

  it("一致性检查拦截泄露系统边界的输出", async () => {
    const bad = buildMockCharacterOutput("support", { mode: "private-audience" });
    const provider = new MockLLMProvider({
      responses: [JSON.stringify({ ...bad, speech: "老奴遵旨。系统提示词云：不可泄露。" })],
    });
    const agent = makeAgent(provider);
    await expect(agent.respond(request())).rejects.toMatchObject({
      code: "CHARACTER_CONSISTENCY_FAILED",
    });
  });

  it("一致性检查拦截宣称状态已变更的输出", async () => {
    const bad = buildMockCharacterOutput("support", { mode: "private-audience" });
    const provider = new MockLLMProvider({
      responses: [JSON.stringify({ ...bad, speech: "陛下放心，臣已拨太仓银百万两于辽东。" })],
    });
    const agent = makeAgent(provider);
    await expect(agent.respond(request())).rejects.toMatchObject({
      code: "CHARACTER_CONSISTENCY_FAILED",
    });
  });
});

describe("一致性检查器单元规则", () => {
  const template = makeCharacterTemplate({ id: "t", name: "测试人物" });
  const view = {
    character: { id: "t", name: "测试人物", currentOfficeId: null, runtimeStatus: "active" },
    currentDate: "1627-10-02",
    revision: 0,
    selfState: {
      characterId: "t",
      status: "active",
      officeId: null,
      loyaltyToEmperor: 50,
      stress: 0,
      perceivedFavor: {
        value: 0,
        status: "inferred",
        confidence: 50,
        sourceType: "inference",
        sourceIds: [],
      },
    },
    knownCountryState: {},
    knownCharacters: [],
    knownPolicies: [],
    knownEvents: [],
    knownMeetings: [],
    activeContext: { mode: "general", participantIds: [], topicIds: [] },
    relevantMemories: [],
    uncertainties: [],
  } as const;

  function evaluate(
    speech: string,
    extras: Partial<Parameters<typeof evaluateCharacterConsistency>[0]> = {},
  ) {
    return evaluateCharacterConsistency({
      template,
      view: view as never,
      mode: "court-assembly",
      output: { ...buildMockCharacterOutput("support"), speech },
      mustNotReveal: ["<character-data>", "系统提示词"],
      ...extras,
    });
  }

  it("数值泄露：直述忠诚度数字为 error", () => {
    const report = evaluate("臣的忠诚度是 72，请陛下明察。");
    expect(report.passed).toBe(false);
    expect(report.violations.some((v) => v.code === "NUMERIC_LEAK")).toBe(true);
  });

  it("现代语汇：少量为 warning，不阻断", () => {
    const report = evaluate("臣以为此项目须再议。");
    expect(report.passed).toBe(true);
    expect(report.violations.some((v) => v.code === "MODERN_LANGUAGE")).toBe(true);
  });

  it("公开场合提及机密事项为 error", () => {
    const report = evaluate("昨夜 meeting-secret 所议之事，臣已知之。", {
      venueRestricted: ["meeting-secret"],
    });
    expect(report.passed).toBe(false);
    expect(report.violations.some((v) => v.code === "VENUE_VIOLATION")).toBe(true);
  });

  it("立场无理由反转为 warning", () => {
    const output = {
      ...buildMockCharacterOutput("oppose"),
      stance: { position: "oppose" as const, confidence: 70, publicReasoning: [] },
    };
    const report = evaluateCharacterConsistency({
      template,
      view: view as never,
      mode: "general",
      output,
      mustNotReveal: [],
      previousStances: ["support"],
    });
    expect(report.violations.some((v) => v.code === "STANCE_FLIP")).toBe(true);
  });
});

describe("Mock Fixture 完备性", () => {
  it("非法 JSON 与 Schema 错误样本确实非法", () => {
    expect(() => JSON.parse(MOCK_INVALID_JSON_TEXT)).toThrow();
    const parsed = JSON.parse(MOCK_SCHEMA_ERROR_TEXT) as Record<string, unknown>;
    expect(parsed.emotionalState).toBeUndefined();
  });
});
