import {
  assessMeetingLeak,
  buildMeetingSummaryMemoryCandidate,
  generateMeetingMinutes,
} from "@mandate/meeting-engine";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW, makeCharacterTemplate, makeFixtureState } from "./helpers/character-fixtures";
import { makeSession, makeTurn } from "./helpers/meeting-fixtures";
import { makeAgendaItem } from "./helpers/meeting-fixtures";

/** §21.8 会议记忆分化 + §21.9 确定性泄密风险。 */

const labels = { emperor: "皇帝", "wei-zhongxian": "魏忠贤", "wang-cheng-en": "王承恩" };

describe("会议纪要与分化记忆（§15/§16）", () => {
  const session = makeSession("concluded", {
    participantIds: ["wei-zhongxian", "wang-cheng-en"],
  });
  const turns = [
    makeTurn({
      turnId: "t0",
      turnNumber: 0,
      speakerId: "emperor",
      publicText: "众卿议厂卫事。",
      visibility: "meeting",
    }),
    makeTurn({
      turnId: "t1",
      turnNumber: 1,
      speakerId: "wei-zhongxian",
      publicText: "老奴惟知报效。",
      visibility: "meeting",
    }),
    makeTurn({
      turnId: "t2",
      turnNumber: 2,
      speakerId: "wang-cheng-en",
      publicText: "此中或有隐情。",
      visibility: "private",
    }),
  ];

  it("正式纪要只含公开回合且逐项引用 sourceTurnIds；私密层单独生成", () => {
    let counter = 0;
    const minutes = generateMeetingMinutes({
      session,
      turns,
      outcomes: [],
      deferredAgendaItemIds: [],
      speakerLabels: labels,
      stateRevision: 3,
      createdAt: FIXTURE_NOW,
      idFactory: () => `fixed-${++counter}`,
    });
    const officialText = JSON.stringify(minutes.official);
    expect(officialText).not.toContain("此中或有隐情"); // private 不入公开纪要
    expect(minutes.official.entries.every((entry) => entry.sourceTurnIds.length > 0)).toBe(true);
    // 不新增事实：条目正文均可溯源到 Transcript 原文
    for (const entry of minutes.official.entries) {
      const source = turns.find((turn) => turn.turnId === entry.sourceTurnIds[0]);
      expect(entry.text).toContain(source!.publicText.slice(0, 8));
    }
    expect(minutes.privateMinutes).toBeDefined();
    expect(JSON.stringify(minutes.privateMinutes)).toContain("此中或有隐情");
    expect(minutes.privateMinutes!.audienceCharacterIds).toEqual(session.participantIds);
  });

  it("重新生成纪要结果确定（同输入同输出）", () => {
    const build = () => {
      let counter = 0;
      return generateMeetingMinutes({
        session,
        turns,
        outcomes: [],
        deferredAgendaItemIds: [],
        speakerLabels: labels,
        stateRevision: 3,
        createdAt: FIXTURE_NOW,
        idFactory: () => `fixed-${++counter}`,
      });
    };
    expect(build()).toEqual(build());
  });

  it("按可见回合生成分化记忆：可见集不同则记忆不同；无可见回合不生成", () => {
    const fullView = buildMeetingSummaryMemoryCandidate(session, turns, [], labels);
    const partialView = buildMeetingSummaryMemoryCandidate(session, turns.slice(0, 1), [], labels);
    expect(fullView).toBeDefined();
    expect(partialView).toBeDefined();
    expect(fullView!.content).not.toBe(partialView!.content);
    expect(partialView!.content).not.toContain("此中或有隐情");
    expect(buildMeetingSummaryMemoryCandidate(session, [], [], labels)).toBeUndefined();
  });

  it("秘密议事的会议记忆可见性为 private 且重要度更高", () => {
    const secret = makeSession("concluded", { type: "secret-council" });
    const memory = buildMeetingSummaryMemoryCandidate(secret, turns, [], labels)!;
    expect(memory.visibility).toBe("private");
    expect(memory.importance).toBeGreaterThanOrEqual(80);
    expect(memory.sourceType).toBe("official-record");
  });
});

describe("确定性泄密风险评估（§21.9，ADR-021）", () => {
  const cautious = makeCharacterTemplate({ id: "wang-cheng-en", name: "王承恩" });
  cautious.personality = { ...cautious.personality, caution: 90 };
  const reckless = makeCharacterTemplate({ id: "cui-chengxiu", name: "崔呈秀" });
  reckless.personality = { ...reckless.personality, caution: 10 };
  const templates = [cautious, reckless];
  const state = makeFixtureState(templates);

  const secretSession = (participantIds: string[]) =>
    makeSession("in-progress", { type: "secret-council", participantIds });

  it("同一 seed 与输入结果完全一致；roll 记录 seed cursor", () => {
    const input = {
      session: secretSession(["wang-cheng-en"]),
      agenda: [makeAgendaItem({ visibility: "sealed" })],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    };
    const a = assessMeetingLeak(input);
    const b = assessMeetingLeak(input);
    expect(a).toEqual(b);
    expect(a.deterministicRoll).toBeDefined();
    expect(a.deterministicRoll!.seedCursorBefore).toBe(state.rng.cursor);
  });

  it("参与人数增加与 sealed 议题提高风险；谨慎降低风险", () => {
    const small = assessMeetingLeak({
      session: secretSession(["wang-cheng-en"]),
      agenda: [],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    });
    const large = assessMeetingLeak({
      session: secretSession(["wang-cheng-en", "cui-chengxiu"]),
      agenda: [],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    });
    expect(large.riskScore).toBeGreaterThan(small.riskScore);

    const sealed = assessMeetingLeak({
      session: secretSession(["wang-cheng-en"]),
      agenda: [makeAgendaItem({ visibility: "sealed" })],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    });
    expect(sealed.riskScore).toBeGreaterThan(small.riskScore);

    expect(small.contributingFactors.some((f) => f.includes("谨慎"))).toBe(true);
    const recklessOnly = assessMeetingLeak({
      session: secretSession(["cui-chengxiu"]),
      agenda: [],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    });
    expect(recklessOnly.riskScore).toBeGreaterThan(small.riskScore);
  });

  it("非秘密会议不做确定性 roll；触发只产生候选事件语义", () => {
    const council = assessMeetingLeak({
      session: makeSession("in-progress", { type: "imperial-council" }),
      agenda: [],
      state,
      templates,
      createdAt: FIXTURE_NOW,
    });
    expect(council.deterministicRoll).toBeUndefined();
    // riskLevel 由分数确定性推导
    expect(["minimal", "low", "moderate", "high", "critical"]).toContain(council.riskLevel);
  });
});
