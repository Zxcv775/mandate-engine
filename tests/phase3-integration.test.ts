import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, createInitialGameState } from "@mandate/game-engine";
import { buildCharacterView, createCharacterMockProvider } from "@mandate/agent-runtime";
import { composeCharacterPrompt } from "@mandate/prompt-system";
import type { CharacterTemplate, GameState, Institution, Office } from "@mandate/domain";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

/** Phase 3 五个集成闭环（§19.7）。全程 Mock，禁网，确定性。 */

const CHARACTER_NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
  "yuan-chonghuan": "袁崇焕",
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
    provider: createCharacterMockProvider(
      { defaultStance: "support", byCharacterId: { "cui-chengxiu": "oppose" } },
      CHARACTER_NAMES,
    ),
    logger: false,
  });
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: {
      saveId: "save_phase3",
      scenarioId: "chongzhen-early",
      title: "Phase 3 集成",
      seed: "phase3-seed",
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe("闭环一：人物上下文（视图→记忆→Prompt，无 hidden）", () => {
  it("加载崇祯场景→构建视图→组合 Prompt→hidden 不存在", async () => {
    const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
    const state = createInitialGameState(
      {
        scenario: bundle.scenario,
        dynasty: bundle.dynasty,
        characters: bundle.characters,
        institutions: bundle.institutions,
        offices: bundle.offices,
        historicalSources: bundle.historicalSources,
      },
      { saveId: "save_ctx", seed: "ctx-seed" },
      new FixedClock(FIXTURE_NOW),
    ) as GameState;
    state.hidden.secretFlags = { conspiracy: "CTX_HIDDEN_MARKER" };
    const templates = {
      characters: structuredClone(bundle.characters) as CharacterTemplate[],
      offices: structuredClone(bundle.offices) as Office[],
      institutions: structuredClone(bundle.institutions) as Institution[],
    };
    const view = buildCharacterView({
      state,
      characterId: "wei-zhongxian",
      context: { mode: "private-audience", participantIds: ["emperor", "wei-zhongxian"] },
      memories: [],
      templates,
    });
    expect(view.character.name).toBe("魏忠贤");
    expect(view.knownCountryState.legitimacy).toBeDefined();
    const composed = await composeCharacterPrompt({
      scenarioName: bundle.scenario.name,
      template: templates.characters.find((value) => value.id === "wei-zhongxian")!,
      view,
      mode: "private-audience",
      participants: [
        { id: "emperor", name: "皇帝" },
        { id: "wei-zhongxian", name: "魏忠贤" },
      ],
      previousTurns: [],
      input: { speakerId: "emperor", speakerLabel: "皇帝", text: "厂卫近报可有欺瞒？" },
    });
    const everything = composed.system + composed.messages.map((m) => m.content).join("\n");
    expect(everything).not.toContain("CTX_HIDDEN_MARKER");
    expect(everything).not.toContain("secretFlags");
    expect(composed.manifest.promptIds.length).toBeGreaterThanOrEqual(11);
  });
});

describe("闭环二：单人物响应（API 全链，revision 不变）", () => {
  it("Mock 私下召见→结构化响应→公开投影→GameState 不变", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/saves/save_phase3/characters/wei-zhongxian/respond",
      payload: {
        expectedRevision: 0,
        mode: "private-audience",
        input: { speakerId: "emperor", text: "辽东局势究竟如何？卿务必据实陈奏。" },
        topic: "liaodong-situation",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: { speech: string; stateRevision: number; stance: { position: string } };
      meta: { requestId: string };
    };
    expect(body.data.speech.length).toBeGreaterThan(0);
    expect(body.data.stateRevision).toBe(0);
    expect(body.meta.requestId.length).toBeGreaterThan(0);

    const state = await app.inject({ method: "GET", url: "/api/saves/save_phase3/state" });
    expect((JSON.parse(state.body) as { data: { revision: number } }).data.revision).toBe(0);
    const changes = await app.inject({ method: "GET", url: "/api/saves/save_phase3/changes" });
    expect((JSON.parse(changes.body) as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe("闭环三：场合差异（同一人物同一议题）", () => {
  it("朝会与私下召见表达不同，核心立场不无理由反转", async () => {
    const payload = (mode: string) => ({
      expectedRevision: 0,
      mode,
      input: { speakerId: "emperor", text: "辽饷之事当如何处置？" },
      topic: "liao-xiang",
    });
    const privateResponse = await app.inject({
      method: "POST",
      url: "/api/saves/save_phase3/characters/cui-chengxiu/respond",
      payload: payload("private-audience"),
    });
    const courtResponse = await app.inject({
      method: "POST",
      url: "/api/saves/save_phase3/characters/cui-chengxiu/respond",
      payload: payload("court-assembly"),
    });
    const privateData = (JSON.parse(privateResponse.body) as {
      data: { speech: string; stance: { position: string } };
    }).data;
    const courtData = (JSON.parse(courtResponse.body) as {
      data: { speech: string; stance: { position: string } };
    }).data;
    expect(privateData.speech).not.toBe(courtData.speech);
    expect(privateData.stance.position).toBe(courtData.stance.position);
  });
});

describe("闭环四：知识限制（秘密议事只授参与者）", () => {
  it("参与者可见密议，未参与者视图与 Prompt 均无泄露", async () => {
    const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
    const state = createInitialGameState(
      {
        scenario: bundle.scenario,
        dynasty: bundle.dynasty,
        characters: bundle.characters,
        institutions: bundle.institutions,
        offices: bundle.offices,
        historicalSources: bundle.historicalSources,
      },
      { saveId: "save_secret", seed: "secret-seed" },
      new FixedClock(FIXTURE_NOW),
    ) as GameState;
    state.meetings = {
      "meeting-chuqi": {
        meetingId: "meeting-chuqi",
        type: "secret-council",
        status: "concluded",
        participantIds: ["wang-cheng-en"],
        sourceIds: [],
      },
    };
    const templates = {
      characters: structuredClone(bundle.characters) as CharacterTemplate[],
      offices: structuredClone(bundle.offices) as Office[],
      institutions: structuredClone(bundle.institutions) as Institution[],
    };
    const participantView = buildCharacterView({
      state,
      characterId: "wang-cheng-en",
      context: { mode: "general" },
      memories: [],
      templates,
    });
    const outsiderView = buildCharacterView({
      state,
      characterId: "huang-liji",
      context: { mode: "general" },
      memories: [],
      templates,
    });
    expect(
      participantView.knownMeetings.some((m) => m.value.meetingId === "meeting-chuqi"),
    ).toBe(true);
    expect(JSON.stringify(outsiderView)).not.toContain("meeting-chuqi");

    const outsiderPrompt = await composeCharacterPrompt({
      scenarioName: bundle.scenario.name,
      template: templates.characters.find((value) => value.id === "huang-liji")!,
      view: outsiderView,
      mode: "private-audience",
      participants: [
        { id: "emperor", name: "皇帝" },
        { id: "huang-liji", name: "黄立极" },
      ],
      previousTurns: [],
      input: { speakerId: "emperor", speakerLabel: "皇帝", text: "近日宫中可有异动？" },
    });
    expect(
      outsiderPrompt.system + outsiderPrompt.messages.map((m) => m.content).join("\n"),
    ).not.toContain("meeting-chuqi");
  });
});

describe("闭环五：记忆候选（审批→落库→再选择，不进 GameState）", () => {
  it("Agent 记忆候选经审批写入并可被后续对话选中", async () => {
    // 第一次召对产生记忆候选（Mock 输出固定含一条 memoryCandidate）
    const first = await app.inject({
      method: "POST",
      url: "/api/saves/save_phase3/characters/wang-cheng-en/respond",
      payload: {
        expectedRevision: 0,
        mode: "private-audience",
        input: { speakerId: "emperor", text: "宫中旧人，可有异动？" },
      },
    });
    expect(first.statusCode).toBe(200);

    const memories = await app.inject({
      method: "GET",
      url: "/api/debug/saves/save_phase3/characters/wang-cheng-en/memories",
    });
    const memoryData = JSON.parse(memories.body) as {
      data: { memories: Array<{ sourceRevision: number; sourceType: string }> };
    };
    expect(memoryData.data.memories.length).toBeGreaterThan(0);
    expect(memoryData.data.memories[0]).toMatchObject({
      sourceRevision: 0,
      sourceType: "observed",
    });

    // 第二次召对：Debug 上下文显示记忆被选择注入
    const debugContext = await app.inject({
      method: "GET",
      url: "/api/debug/saves/save_phase3/characters/wang-cheng-en/context",
    });
    const contextData = JSON.parse(debugContext.body) as {
      data: { memories: { selected: unknown[] } };
    };
    expect(contextData.data.memories.selected.length).toBeGreaterThan(0);

    // 记忆不进入 GameState / StateChangeLog
    const state = await app.inject({ method: "GET", url: "/api/saves/save_phase3/state" });
    const stateBody = state.body;
    expect((JSON.parse(stateBody) as { data: { revision: number } }).data.revision).toBe(0);
    expect(stateBody).not.toContain("memoryCandidates");
    const changes = await app.inject({ method: "GET", url: "/api/saves/save_phase3/changes" });
    expect((JSON.parse(changes.body) as { data: unknown[] }).data).toHaveLength(0);
  });
});
