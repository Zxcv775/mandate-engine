import {
  evaluateSpeakerEligibility,
  planNextStep,
  scheduleNextSpeaker,
} from "@mandate/meeting-engine";
import { describe, expect, it } from "vitest";
import {
  makeAgendaItem,
  makeCandidate,
  makeEligibilityInput,
  makeParticipant,
  makeRuntime,
  makeSession,
  makeTurn,
} from "./helpers/meeting-fixtures";

/** §21.2 参与者资格 + §21.3 Speaker Scheduler + Director 决策树（M2）。 */

describe("发言资格（§21.2）", () => {
  const session = makeSession();

  it("正常受邀在场者具备资格", () => {
    const result = evaluateSpeakerEligibility(makeEligibilityInput("wei-zhongxian", session));
    expect(result).toMatchObject({ eligible: true, reasons: [] });
  });

  it("人物不存在 / 非 active（去职、监禁、身故）不具备资格", () => {
    const missing = evaluateSpeakerEligibility(
      makeEligibilityInput("nobody", session, { runtime: undefined }),
    );
    expect(missing.reasons).toContain("CHARACTER_MISSING");
    for (const status of ["dismissed", "imprisoned", "dead"] as const) {
      const result = evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { runtime: makeRuntime("x", { status }) }),
      );
      expect(result.reasons, status).toContain("CHARACTER_NOT_ACTIVE");
    }
  });

  it("非参会者 / 未到场者不具备资格", () => {
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { participant: undefined }),
      ).reasons,
    ).toContain("NOT_PARTICIPANT");
    for (const attendance of ["invited", "absent", "dismissed", "removed"] as const) {
      expect(
        evaluateSpeakerEligibility(
          makeEligibilityInput("x", session, {
            participant: makeParticipant("x", { attendance }),
          }),
        ).reasons,
        attendance,
      ).toContain("NOT_PRESENT");
    }
  });

  it("silenced 不可发言；observer-only 不可主动发言但被点名后可以", () => {
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, {
          participant: makeParticipant("x", { speakingRights: "silenced" }),
        }),
      ).reasons,
    ).toContain("SILENCED");

    const observer = makeParticipant("x", { speakingRights: "observer-only" });
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { participant: observer }),
      ).eligible,
    ).toBe(false);
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { participant: observer, emperorSelected: true }),
      ).eligible,
    ).toBe(true);
  });

  it("by-permission 需要点名或既有授权", () => {
    const restricted = makeParticipant("x", { speakingRights: "by-permission" });
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { participant: restricted }),
      ).reasons,
    ).toContain("PERMISSION_REQUIRED");
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, {
          participant: makeParticipant("x", {
            speakingRights: "by-permission",
            grantedByEmperorAtTurn: 3,
          }),
        }),
      ).eligible,
    ).toBe(true);
  });

  it("议题官职限制：不任要求官职者不可发言，点名可豁免", () => {
    const agendaItem = makeAgendaItem({ requiredOfficeIds: ["bing-bu-shang-shu"] });
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { agendaItem }),
      ).reasons,
    ).toContain("AGENDA_OFFICE_REQUIRED");
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, {
          agendaItem,
          runtime: makeRuntime("x", { officeId: "bing-bu-shang-shu" }),
        }),
      ).eligible,
    ).toBe(true);
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { agendaItem, emperorSelected: true }),
      ).eligible,
    ).toBe(true);
  });

  it("发言上限 / pending Agent 请求 / 无议题信息访问均不合格", () => {
    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, {
          participant: makeParticipant("x", {
            turnsSpoken: session.limits.maxTurnsPerCharacter,
          }),
        }),
      ).reasons,
    ).toContain("TURN_LIMIT_REACHED");

    const pendingSession = makeSession("waiting-for-agent", {
      pendingAgentAction: {
        actionId: "act-1",
        characterId: "huang-liji",
        responseMode: "speech",
        addressedCharacterIds: [],
        reservedAtTurn: 0,
        reservedAt: "2026-07-26T00:00:00.000Z",
      },
    });
    expect(
      evaluateSpeakerEligibility(makeEligibilityInput("x", pendingSession)).reasons,
    ).toContain("AGENT_REQUEST_PENDING");

    expect(
      evaluateSpeakerEligibility(
        makeEligibilityInput("x", session, { topicAccess: "none" }),
      ).reasons,
    ).toContain("NO_TOPIC_ACCESS");
  });
});

describe("Speaker Scheduler（§21.3）", () => {
  const session = makeSession();
  const agendaItem = makeAgendaItem({ topicIds: ["liaodong", "chan-wei"] });

  it("皇帝点名绝对优先", () => {
    const result = scheduleNextSpeaker(session, agendaItem, [
      makeCandidate("a", session, { specialistDomains: ["liaodong", "chan-wei"] }),
      makeCandidate("b", session, { eligibility: { emperorSelected: true } }),
    ]);
    expect(result.selected?.characterId).toBe("b");
    expect(result.selected?.emperorSelected).toBe(100);
  });

  it("议题专业相关者优先于无关者", () => {
    const result = scheduleNextSpeaker(session, agendaItem, [
      makeCandidate("expert", session, { specialistDomains: ["liaodong"] }),
      makeCandidate("layman", session),
    ]);
    expect(result.selected?.characterId).toBe("expert");
    expect(result.rankings.find((r) => r.characterId === "expert")?.topicRelevance).toBe(15);
  });

  it("官职责任加分；主动请求发言加分；被质疑者加分", () => {
    const officeAgenda = makeAgendaItem({ requiredOfficeIds: ["bing-bu-shang-shu"] });
    const office = scheduleNextSpeaker(session, officeAgenda, [
      makeCandidate("holder", session, {
        eligibility: { runtime: makeRuntime("holder", { officeId: "bing-bu-shang-shu" }) },
      }),
      makeCandidate("selected", session, { eligibility: { emperorSelected: true } }),
    ]);
    expect(
      office.rankings.find((r) => r.characterId === "holder")?.officeResponsibility,
    ).toBe(25);

    const requested = scheduleNextSpeaker(session, agendaItem, [
      makeCandidate("asker", session, {
        eligibility: { participant: makeParticipant("asker", { requestedToSpeak: true }) },
      }),
      makeCandidate("quiet", session),
    ]);
    expect(requested.selected?.characterId).toBe("asker");

    const challenged = scheduleNextSpeaker(session, agendaItem, [
      makeCandidate("target", session),
      makeCandidate("challenger", session, {
        eligibility: {
          participant: makeParticipant("challenger", {
            challengedCharacterIds: ["target"],
            turnsSpoken: 3,
          }),
        },
      }),
    ]);
    expect(
      challenged.rankings.find((r) => r.characterId === "target")?.challenged,
    ).toBe(15);
  });

  it("刚发言者与发言次数多者受罚；谨慎人物有沉默倾向；立场多样性生效", () => {
    const busySession = makeSession("in-progress", { turnNumber: 6 });
    const result = scheduleNextSpeaker(busySession, agendaItem, [
      makeCandidate("fresh", busySession, { stanceDiversityBonus: 10 }),
      makeCandidate("busy", busySession, {
        eligibility: {
          participant: makeParticipant("busy", { turnsSpoken: 4, lastSpokeAtTurn: 5 }),
        },
      }),
      makeCandidate("timid", busySession, { personality: { caution: 90 } }),
    ]);
    expect(result.selected?.characterId).toBe("fresh");
    const busy = result.rankings.find((r) => r.characterId === "busy")!;
    expect(busy.recentTurnPenalty).toBe(25);
    expect(busy.turnCountPenalty).toBe(16);
    expect(result.rankings.find((r) => r.characterId === "timid")?.silencePenalty).toBe(8);
    expect(result.rankings.find((r) => r.characterId === "fresh")?.stanceDiversity).toBe(10);
  });

  it("无资格人物永不入选；全员无资格时无 selected", () => {
    const result = scheduleNextSpeaker(session, agendaItem, [
      makeCandidate("silenced", session, {
        eligibility: {
          participant: makeParticipant("silenced", { speakingRights: "silenced" }),
        },
      }),
      makeCandidate("absent", session, {
        eligibility: { participant: makeParticipant("absent", { attendance: "absent" }) },
      }),
    ]);
    expect(result.selected).toBeUndefined();
    expect(result.ineligible).toHaveLength(2);
  });

  it("同分 tie-break 确定性：同输入同结果，不用 Math.random", () => {
    const run = () =>
      scheduleNextSpeaker(session, agendaItem, [
        makeCandidate("alpha", session),
        makeCandidate("beta", session),
      ]);
    const first = run();
    expect(first.tieBreakUsed).toBe(true);
    for (let index = 0; index < 5; index++) {
      expect(run().selected?.characterId).toBe(first.selected?.characterId);
    }
    // turnNumber 变化 → tie-break 可能不同，但仍确定
    const laterSession = makeSession("in-progress", { turnNumber: 7 });
    const later = () =>
      scheduleNextSpeaker(laterSession, agendaItem, [
        makeCandidate("alpha", laterSession),
        makeCandidate("beta", laterSession),
      ]);
    expect(later().selected?.characterId).toBe(later().selected?.characterId);
  });
});

describe("Meeting Director 决策树", () => {
  const session = makeSession();
  const agenda = [makeAgendaItem()];

  it("点名与要求回应直接产生 request-character-response", () => {
    const named = planNextStep({
      session,
      agenda,
      recentTurns: [],
      candidates: [makeCandidate("wei-zhongxian", session)],
      lastPlayerAction: { type: "ask-character", characterId: "wei-zhongxian", text: "实情如何？" },
    });
    expect(named.decision).toMatchObject({
      type: "request-character-response",
      characterId: "wei-zhongxian",
      responseMode: "answer",
    });

    const rebuttal = planNextStep({
      session,
      agenda,
      recentTurns: [],
      candidates: [],
      lastPlayerAction: {
        type: "request-rebuttal",
        characterId: "cui-chengxiu",
        targetCharacterId: "wang-cheng-en",
      },
    });
    expect(rebuttal.decision).toMatchObject({
      type: "request-character-response",
      responseMode: "rebuttal",
      addressedCharacterIds: ["wang-cheng-en"],
    });
  });

  it("会议与议程上限触发玩家裁决/进入裁决", () => {
    const maxed = planNextStep({
      session: makeSession("in-progress", { usedTurns: session.limits.maxTurns }),
      agenda,
      recentTurns: [],
      candidates: [],
    });
    expect(maxed.decision.type).toBe("request-player-action");

    const agendaMaxed = planNextStep({
      session,
      agenda: [makeAgendaItem({ usedTurns: 24 })],
      recentTurns: [],
      candidates: [],
    });
    expect(agendaMaxed.decision).toMatchObject({
      type: "prepare-decision",
      agendaItemId: "agenda-1",
    });
  });

  it("连续 Agent 回合与连续反驳达到上限后请求玩家介入", () => {
    const agentTurns = Array.from({ length: session.limits.maxConsecutiveAgentTurns }, (_, i) =>
      makeTurn({ turnNumber: i, type: "character-speech" }),
    );
    expect(
      planNextStep({ session, agenda, recentTurns: agentTurns, candidates: [] }).decision.type,
    ).toBe("request-player-action");

    const rebuttals = Array.from({ length: session.limits.maxConsecutiveRebuttals }, (_, i) =>
      makeTurn({ turnNumber: i, type: "character-rebuttal" }),
    );
    expect(
      planNextStep({ session, agenda, recentTurns: rebuttals, candidates: [] }).decision.type,
    ).toBe("request-player-action");
  });

  it("无当前议程时推进下一项；全部议毕则散会", () => {
    const advancing = planNextStep({
      session: makeSession("in-progress", { currentAgendaItemId: undefined }),
      agenda: [
        makeAgendaItem({ agendaItemId: "agenda-2", status: "queued", sequence: 1 }),
        makeAgendaItem({ agendaItemId: "agenda-1", status: "resolved", sequence: 0 }),
      ],
      recentTurns: [],
      candidates: [],
    });
    expect(advancing.decision).toMatchObject({
      type: "advance-agenda",
      nextAgendaItemId: "agenda-2",
    });

    const done = planNextStep({
      session: makeSession("in-progress", { currentAgendaItemId: undefined }),
      agenda: [makeAgendaItem({ status: "resolved" })],
      recentTurns: [],
      candidates: [],
    });
    expect(done.decision.type).toBe("conclude-meeting");
  });

  it("pending Agent 回合存在时拒绝规划（须先恢复）", () => {
    expect(() =>
      planNextStep({
        session: makeSession("in-progress", {
          pendingAgentAction: {
            actionId: "act-1",
            characterId: "wei-zhongxian",
            responseMode: "speech",
            addressedCharacterIds: [],
            reservedAtTurn: 0,
            reservedAt: "2026-07-26T00:00:00.000Z",
          },
        }),
        agenda,
        recentTurns: [],
        candidates: [],
      }),
    ).toThrowError(/未完成的 Agent 回合/);
  });

  it("默认路径：调度最高分者发言；无合格者时请求玩家动作", () => {
    const scheduled = planNextStep({
      session,
      agenda,
      recentTurns: [],
      candidates: [
        makeCandidate("expert", session, { specialistDomains: ["chan-wei"] }),
        makeCandidate("layman", session),
      ],
    });
    expect(scheduled.decision).toMatchObject({
      type: "request-character-response",
      characterId: "expert",
      responseMode: "speech",
    });
    expect(scheduled.scheduling?.rankings.length).toBe(2);

    const nobody = planNextStep({ session, agenda, recentTurns: [], candidates: [] });
    expect(nobody.decision.type).toBe("request-player-action");
  });
});
