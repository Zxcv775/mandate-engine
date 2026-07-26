import type { GameState, Institution, Office } from "@mandate/domain";
import { buildCharacterView, CharacterAgentError } from "@mandate/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  makeCharacterTemplate,
  makeFixtureState,
  makeMemory,
} from "./helpers/character-fixtures";

/**
 * 角色有限知识视图测试（ADR-011）。
 * 场景：户部尚书（财政特权）、普通朝臣（无特权）、去职在籍者（消息滞后）。
 */

const OFFICES: Office[] = [
  {
    id: "hu-bu-shang-shu",
    name: "户部尚书",
    grade: 2,
    institutionId: "hu-bu",
    powers: ["度支"],
    quota: 1,
    meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
  },
  {
    id: "bing-bu-shang-shu",
    name: "兵部尚书",
    grade: 2,
    institutionId: "bing-bu",
    powers: ["军政"],
    quota: 1,
    meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
  },
];

const INSTITUTIONS: Institution[] = [
  {
    id: "hu-bu",
    name: "户部",
    type: "fiscal",
    functions: ["度支"],
    meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
  },
  {
    id: "bing-bu",
    name: "兵部",
    type: "military",
    functions: ["军政"],
    meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
  },
];

const treasurer = makeCharacterTemplate({
  id: "treasurer",
  name: "户部堂官",
  identity: {
    dynastyId: "ming",
    historicalOfficeIds: ["hu-bu-shang-shu"],
    initialOfficeId: "hu-bu-shang-shu",
    aliases: [],
  },
});
const courtier = makeCharacterTemplate({ id: "courtier", name: "普通朝臣" });
const retiree = makeCharacterTemplate({
  id: "retiree",
  name: "去职之臣",
  identity: {
    dynastyId: "ming",
    historicalOfficeIds: [],
    initialOfficeId: null,
    initialRuntimeStatus: "dismissed",
    aliases: [],
  },
  knowledgeProfile: {
    specialistDomains: ["军务"],
    familiarRegions: ["辽东"],
    informationChannels: ["旧部私书"],
    accessLevels: [{ domain: "military", level: "normal" }],
    commonBiases: [],
    blindSpots: [],
  },
});

const TEMPLATES = {
  characters: [treasurer, courtier, retiree],
  offices: OFFICES,
  institutions: INSTITUTIONS,
};

function fixtureState(): GameState {
  const state = makeFixtureState([treasurer, courtier, retiree], {
    offices: OFFICES,
    institutions: INSTITUTIONS,
  });
  // 注入用于泄露检测的隐藏数据与各类实体
  state.hidden.secretFlags = { "plot-marker-secret": "SECRET_PLOT_VALUE" };
  state.hidden.internalNotes = ["INTERNAL_NOTE_MARKER"];
  state.hidden.undiscoveredInformation = { spy: "UNDISCOVERED_MARKER" };
  state.hidden.queuedEventIds = ["hidden-event-1"];
  state.eventQueue.processedEventIds = ["public-event-1"];
  state.meetings = {
    "meeting-secret": {
      meetingId: "meeting-secret",
      type: "secret-council",
      status: "concluded",
      participantIds: ["treasurer"],
      sourceIds: [],
    },
    "meeting-court": {
      meetingId: "meeting-court",
      type: "court-assembly",
      status: "concluded",
      participantIds: ["treasurer", "courtier"],
      sourceIds: [],
    },
    "meeting-council": {
      meetingId: "meeting-council",
      type: "imperial-council",
      status: "concluded",
      participantIds: ["treasurer"],
      sourceIds: [],
    },
    "meeting-private": {
      meetingId: "meeting-private",
      type: "private-audience",
      status: "concluded",
      participantIds: ["treasurer"],
      sourceIds: [],
    },
  };
  return state;
}

function view(characterId: string, state = fixtureState(), memories: Parameters<typeof buildCharacterView>[0]["memories"] = []) {
  return buildCharacterView({
    state,
    characterId,
    context: { mode: "private-audience", participantIds: ["emperor", characterId] },
    memories,
    templates: TEMPLATES,
  });
}

describe("Character View Builder（ADR-011）", () => {
  it("人物不存在时报 CHARACTER_NOT_FOUND", () => {
    expect(() => view("nobody")).toThrowError(CharacterAgentError);
  });

  it("普通朝臣只见公开信息：无财政实数，只有朝局体感", () => {
    const result = view("courtier");
    expect(result.knownCountryState.treasuryTaels).toBeUndefined();
    expect(result.knownCountryState.militaryReadiness).toBeUndefined();
    expect(result.knownCountryState.legitimacy?.status).toBe("inferred");
  });

  it("官职带来额外信息：户部尚书确知国库实数", () => {
    const state = fixtureState();
    const result = view("treasurer", state);
    expect(result.knownCountryState.treasuryTaels).toMatchObject({
      value: state.country.treasuryTaels,
      status: "known",
      sourceType: "official",
    });
  });

  it("会议按参与者过滤：参与者可见秘密议事，未参与者完全不可见", () => {
    const treasurerView = view("treasurer");
    const courtierView = view("courtier");
    const ids = (value: typeof treasurerView) =>
      value.knownMeetings.map((meeting) => meeting.value.meetingId);
    expect(ids(treasurerView)).toContain("meeting-secret");
    expect(ids(courtierView)).not.toContain("meeting-secret");
    expect(ids(courtierView)).not.toContain("meeting-private");
  });

  it("朝会公开可见；御前会议对未参与者仅为传闻且不泄名单", () => {
    const courtierView = view("courtier");
    const court = courtierView.knownMeetings.find(
      (meeting) => meeting.value.meetingId === "meeting-court",
    );
    expect(court?.status).toBe("known");
    const council = courtierView.knownMeetings.find(
      (meeting) => meeting.value.meetingId === "meeting-council",
    );
    expect(council?.status).toBe("reported");
    expect(council?.value.participantIds).toEqual([]);
  });

  it("其他人物的忠诚/圣眷/压力等私密数值不进入视图", () => {
    const serialized = JSON.stringify(view("courtier").knownCharacters);
    expect(serialized).not.toContain("loyalty");
    expect(serialized).not.toContain("favor");
    expect(serialized).not.toContain("stress");
  });

  it("hidden 与 sealed 数据永不泄露", () => {
    const serialized = JSON.stringify(view("treasurer"));
    for (const marker of [
      "SECRET_PLOT_VALUE",
      "plot-marker-secret",
      "INTERNAL_NOTE_MARKER",
      "UNDISCOVERED_MARKER",
      "hidden-event-1",
      "secretFlags",
      "undiscoveredInformation",
    ]) {
      expect(serialized, `不得包含 ${marker}`).not.toContain(marker);
    }
  });

  it("未公开事件队列不可见，已发生事件可见", () => {
    const result = view("courtier");
    const ids = result.knownEvents.map((event) => event.value.eventId);
    expect(ids).toContain("public-event-1");
    expect(ids).not.toContain("hidden-event-1");
  });

  it("去职在籍者信息滞后：数值粗化、标记 outdated 并产生不确定性", () => {
    const state = fixtureState();
    const result = view("retiree", state);
    const readiness = result.knownCountryState.militaryReadiness;
    expect(readiness?.status).toBe("outdated");
    expect(readiness?.value).toBe(Math.round(state.country.militaryReadiness / 10) * 10);
    expect(result.uncertainties.some((item) => item.topic === "朝局近况")).toBe(true);
  });

  it("传闻级访问只得约数：低权限者不知财政实数", () => {
    const limitedCourtier = makeCharacterTemplate({
      id: "courtier",
      name: "普通朝臣",
      knowledgeProfile: {
        specialistDomains: [],
        familiarRegions: [],
        informationChannels: ["市井传闻"],
        accessLevels: [{ domain: "state-finance", level: "limited" }],
        commonBiases: [],
        blindSpots: [],
      },
    });
    const state = fixtureState();
    const result = buildCharacterView({
      state,
      characterId: "courtier",
      context: { mode: "general" },
      memories: [],
      templates: { ...TEMPLATES, characters: [treasurer, limitedCourtier, retiree] },
    });
    const treasury = result.knownCountryState.treasuryTaels;
    expect(treasury?.status).toBe("reported");
    expect(treasury?.sourceType).toBe("rumor");
    expect((treasury?.value ?? 0) % 500_000).toBe(0);
  });

  it("错误认知（contradicted 记忆）保留原样，不被自动纠正", () => {
    const memory = makeMemory({
      memoryId: "mem-wrong",
      characterId: "courtier",
      content: "误信国库尚有千万两之富",
      status: "contradicted",
      confidence: 40,
    });
    const result = view("courtier", fixtureState(), [memory]);
    const projected = result.relevantMemories.find((item) => item.memoryId === "mem-wrong");
    expect(projected).toMatchObject({ status: "contradicted", content: memory.content });
  });

  it("sealed 记忆默认不可见；Debug 授权后方可投影（与普通视图区分）", () => {
    const sealed = makeMemory({
      memoryId: "mem-sealed",
      characterId: "courtier",
      content: "SEALED_MEMORY_MARKER",
      visibility: "sealed",
    });
    const normal = view("courtier", fixtureState(), [sealed]);
    expect(JSON.stringify(normal)).not.toContain("SEALED_MEMORY_MARKER");
    const debug = buildCharacterView({
      state: fixtureState(),
      characterId: "courtier",
      context: { mode: "general" },
      memories: [sealed],
      templates: TEMPLATES,
      authorization: { includeSealedMemories: true },
    });
    expect(JSON.stringify(debug)).toContain("SEALED_MEMORY_MARKER");
  });

  it("他人记忆不会进入本人视图", () => {
    const foreign = makeMemory({
      memoryId: "mem-foreign",
      characterId: "treasurer",
      content: "FOREIGN_MEMORY_MARKER",
    });
    const result = view("courtier", fixtureState(), [foreign]);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_MEMORY_MARKER");
  });

  it("同一输入构建结果确定", () => {
    const a = view("treasurer");
    const b = view("treasurer");
    expect(a).toEqual(b);
  });
});
