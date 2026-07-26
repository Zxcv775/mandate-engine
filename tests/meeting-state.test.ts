import {
  MeetingEngineError,
  describeTransitionMatrix,
  transitionMeeting,
} from "@mandate/meeting-engine";
import {
  DEFAULT_MEETING_LIMITS,
  type GameCommand,
  type MeetingSessionState,
  type MeetingSessionStatus,
  type MeetingStateEvent,
} from "@mandate/domain";
import {
  FixedClock,
  StateEngine,
  StateEngineError,
  applyMutation,
  invertMutation,
  hashState,
} from "@mandate/game-engine";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_NOW,
  makeCharacterTemplate,
  makeFixtureState,
} from "./helpers/character-fixtures";

/** Meeting State Machine 全矩阵 + meeting.* 命令经 StateEngine 的最小投影测试（M1）。 */

const ALL_STATUSES: readonly MeetingSessionStatus[] = [
  "draft",
  "scheduled",
  "preparing",
  "in-progress",
  "waiting-for-player",
  "waiting-for-agent",
  "resolving",
  "paused",
  "concluded",
  "cancelled",
  "failed",
];

function makeSession(status: MeetingSessionStatus): MeetingSessionState {
  return {
    meetingId: "meeting-1",
    saveId: "save_demo",
    type: "imperial-council",
    status,
    title: "御前会议",
    purpose: "议辽东事",
    createdAtRevision: 0,
    meetingVersion: 3,
    turnNumber: 2,
    participantIds: ["wei-zhongxian"],
    chairCharacterId: "emperor",
    agendaItemIds: ["agenda-1"],
    ...(status === "resolving" ? { currentAgendaItemId: "agenda-1" } : {}),
    ...(status === "waiting-for-agent"
      ? {
          pendingAgentAction: {
            actionId: "act-1",
            characterId: "wei-zhongxian",
            responseMode: "speech" as const,
            addressedCharacterIds: [],
            reservedAtTurn: 2,
            reservedAt: FIXTURE_NOW,
          },
        }
      : {}),
    limits: DEFAULT_MEETING_LIMITS,
    usedTurns: 2,
    visibility: "meeting",
    outcomeCandidateIds: [],
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
}

function eventFor(type: MeetingStateEvent["type"]): MeetingStateEvent {
  switch (type) {
    case "meeting.pause":
      return { type, reason: "测试暂停" };
    case "meeting.cancel":
      return { type, reason: "测试取消" };
    case "meeting.fail":
      return { type, errorCode: "PROVIDER_REQUEST_FAILED" };
    case "meeting.await-player":
      return {
        type,
        action: { allowedActions: ["address-meeting"], reason: "等待圣裁", requestedAtTurn: 2 },
      };
    case "meeting.await-agent":
    case "meeting.agent-completed":
      return { type, characterId: "wei-zhongxian" };
    case "meeting.open-agenda":
    case "meeting.begin-resolution":
    case "meeting.resolve-agenda":
      return { type, agendaItemId: "agenda-1" };
    default:
      return { type } as MeetingStateEvent;
  }
}

describe("Meeting State Machine 转换矩阵", () => {
  const matrix = describeTransitionMatrix();

  it("覆盖全部事件与全部状态：合法转换成功、非法转换拒绝", () => {
    for (const rule of matrix) {
      for (const status of ALL_STATUSES) {
        const session = makeSession(status);
        const event = eventFor(rule.event);
        if (rule.allowedFrom.includes(status)) {
          const result = transitionMeeting(session, event);
          expect(result.from).toBe(status);
          expect(result.to).toBe(rule.to);
          expect(result.next.status).toBe(rule.to);
          expect(result.next.meetingVersion).toBe(session.meetingVersion + 1);
        } else {
          expect(
            () => transitionMeeting(session, event),
            `${rule.event} 不应允许从 ${status} 触发`,
          ).toThrowError(MeetingEngineError);
        }
      }
    }
  });

  it("终态 concluded 与 cancelled 不接受任何事件（含重复 conclude/cancel）", () => {
    for (const status of ["concluded", "cancelled"] as const) {
      for (const rule of matrix) {
        expect(() => transitionMeeting(makeSession(status), eventFor(rule.event))).toThrowError(
          MeetingEngineError,
        );
      }
    }
  });

  it("推荐主路径：draft→scheduled→preparing→in-progress→等待→resolving→concluded", () => {
    let session = makeSession("draft");
    const path: MeetingStateEvent[] = [
      { type: "meeting.schedule" },
      { type: "meeting.start-preparation" },
      { type: "meeting.start" },
      eventFor("meeting.open-agenda"),
      eventFor("meeting.await-player"),
      { type: "meeting.step-completed" },
      eventFor("meeting.await-agent"),
      { type: "meeting.agent-completed", characterId: "wei-zhongxian" },
      eventFor("meeting.begin-resolution"),
      eventFor("meeting.resolve-agenda"),
      { type: "meeting.conclude" },
    ];
    const initialVersion = session.meetingVersion;
    for (const event of path) {
      session = transitionMeeting(session, event).next;
    }
    expect(session.status).toBe("concluded");
    expect(session.meetingVersion).toBe(initialVersion + path.length);
    expect(session.pendingPlayerAction).toBeUndefined();
    expect(session.pendingAgentAction).toBeUndefined();
  });

  it("暂停可恢复；failed 经 pause 恢复或取消", () => {
    const paused = transitionMeeting(makeSession("in-progress"), eventFor("meeting.pause")).next;
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("测试暂停");
    const resumed = transitionMeeting(paused, { type: "meeting.resume" }).next;
    expect(resumed.status).toBe("in-progress");
    expect(resumed.pauseReason).toBeUndefined();

    const failed = transitionMeeting(makeSession("waiting-for-agent"), eventFor("meeting.fail")).next;
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("PROVIDER_REQUEST_FAILED");
    const recovered = transitionMeeting(failed, eventFor("meeting.pause")).next;
    expect(recovered.status).toBe("paused");
    const cancelled = transitionMeeting(
      transitionMeeting(makeSession("waiting-for-agent"), eventFor("meeting.fail")).next,
      eventFor("meeting.cancel"),
    ).next;
    expect(cancelled.status).toBe("cancelled");
  });

  it("await-player 记录待办；agent-completed 校验发言者并清除 pending", () => {
    const waiting = transitionMeeting(
      makeSession("in-progress"),
      eventFor("meeting.await-player"),
    ).next;
    expect(waiting.pendingPlayerAction?.reason).toBe("等待圣裁");

    expect(() =>
      transitionMeeting(makeSession("waiting-for-agent"), {
        type: "meeting.agent-completed",
        characterId: "huang-liji",
      }),
    ).toThrowError(/等待的发言者/);
  });

  it("open-agenda 拒绝不属于本会议的议程", () => {
    expect(() =>
      transitionMeeting(makeSession("in-progress"), {
        type: "meeting.open-agenda",
        agendaItemId: "agenda-unknown",
      }),
    ).toThrowError(MeetingEngineError);
  });
});

describe("meeting.* 命令经 StateEngine（最小投影，ADR-015）", () => {
  const characters = [
    makeCharacterTemplate({ id: "wei-zhongxian", name: "魏忠贤" }),
    makeCharacterTemplate({ id: "huang-liji", name: "黄立极" }),
    makeCharacterTemplate({
      id: "yuan-chonghuan",
      name: "袁崇焕",
      identity: {
        dynastyId: "ming",
        historicalOfficeIds: [],
        initialOfficeId: null,
        initialRuntimeStatus: "dismissed",
        aliases: [],
      },
    }),
  ];
  const engine = new StateEngine({ clock: new FixedClock(FIXTURE_NOW) });

  function command(
    commandType: GameCommand["commandType"],
    payload: unknown,
    baseRevision = 0,
  ): GameCommand {
    return {
      commandId: `cmd_${commandType}_${baseRevision}`,
      commandType,
      saveId: "save_demo",
      baseRevision,
      actor: { type: "system", id: "meeting-director" },
      payload,
      createdAt: FIXTURE_NOW,
    } as GameCommand;
  }

  const createPayload = {
    meetingId: "meeting-yuqian",
    meetingType: "imperial-council",
    participantIds: ["wei-zhongxian", "huang-liji"],
    chairCharacterId: "emperor",
    visibility: "meeting",
  };

  it("meeting.create 新增最小投影记录并递增 revision", () => {
    const state = makeFixtureState(characters);
    const transition = engine.applyCommand(state, command("meeting.create", createPayload));
    expect(transition.nextState.revision).toBe(1);
    expect(transition.nextState.meetings["meeting-yuqian"]).toMatchObject({
      meetingId: "meeting-yuqian",
      type: "imperial-council",
      status: "scheduled",
      chairCharacterId: "emperor",
      visibility: "meeting",
    });
    const addMutation = transition.mutations.find((m) => m.operation === "add");
    expect(addMutation?.path).toBe("/meetings/meeting-yuqian");
    // add 的逆是 remove：可完整回滚
    const reverted = applyMutation(transition.nextState, invertMutation(addMutation!));
    expect(reverted.meetings["meeting-yuqian"]).toBeUndefined();
  });

  it("meeting.start / conclude / cancel 状态推进且记录 revision 锚点", () => {
    let state = makeFixtureState(characters);
    state = engine.applyCommand(state, command("meeting.create", createPayload)).nextState;
    state = engine.applyCommand(
      state,
      command("meeting.start", { meetingId: "meeting-yuqian" }, 1),
    ).nextState;
    expect(state.meetings["meeting-yuqian"]).toMatchObject({
      status: "in-progress",
      startedAtRevision: 2,
    });
    const concluded = engine.applyCommand(
      state,
      command(
        "meeting.conclude",
        { meetingId: "meeting-yuqian", leakEventCandidateIds: ["leak-evt-1"] },
        2,
      ),
    ).nextState;
    expect(concluded.meetings["meeting-yuqian"]).toMatchObject({
      status: "concluded",
      concludedAtRevision: 3,
    });
    expect(concluded.hidden.queuedEventIds).toContain("leak-evt-1");
  });

  it("泄密候选事件的 mutation 是 sealed，不进入公开日志投影", () => {
    let state = makeFixtureState(characters);
    state = engine.applyCommand(state, command("meeting.create", createPayload)).nextState;
    state = engine.applyCommand(
      state,
      command("meeting.start", { meetingId: "meeting-yuqian" }, 1),
    ).nextState;
    const transition = engine.applyCommand(
      state,
      command(
        "meeting.conclude",
        { meetingId: "meeting-yuqian", leakEventCandidateIds: ["leak-evt-9"] },
        2,
      ),
    );
    const leakMutation = transition.mutations.find((m) => m.path === "/hidden/queuedEventIds");
    expect(leakMutation?.visibility).toBe("sealed");
  });

  it("非法生命周期被拒绝：重复创建/重复开始/重复结束/取消已结束", () => {
    let state = makeFixtureState(characters);
    state = engine.applyCommand(state, command("meeting.create", createPayload)).nextState;
    expect(() =>
      engine.applyCommand(state, command("meeting.create", createPayload, 1)),
    ).toThrowError(StateEngineError);

    state = engine.applyCommand(
      state,
      command("meeting.start", { meetingId: "meeting-yuqian" }, 1),
    ).nextState;
    expect(() =>
      engine.applyCommand(state, command("meeting.start", { meetingId: "meeting-yuqian" }, 2)),
    ).toThrowError(/无法开始|已开始/);

    state = engine.applyCommand(
      state,
      command("meeting.conclude", { meetingId: "meeting-yuqian" }, 2),
    ).nextState;
    expect(() =>
      engine.applyCommand(state, command("meeting.conclude", { meetingId: "meeting-yuqian" }, 3)),
    ).toThrowError(/已结束/);
    expect(() =>
      engine.applyCommand(
        state,
        command("meeting.cancel", { meetingId: "meeting-yuqian", reason: "撤销" }, 3),
      ),
    ).toThrowError(StateEngineError);
  });

  it("非 active 参与者与不存在的会议被拒绝", () => {
    const state = makeFixtureState(characters);
    expect(() =>
      engine.applyCommand(
        state,
        command("meeting.create", {
          ...createPayload,
          meetingId: "meeting-bad",
          participantIds: ["yuan-chonghuan"],
        }),
      ),
    ).toThrowError(/不可与会/);
    expect(() =>
      engine.applyCommand(state, command("meeting.start", { meetingId: "meeting-none" })),
    ).toThrowError(/会议不存在/);
  });

  it("会议命令重放确定性：同序列得到同一 state hash", () => {
    const run = () => {
      let state = makeFixtureState(characters);
      state = engine.applyCommand(state, command("meeting.create", createPayload)).nextState;
      state = engine.applyCommand(
        state,
        command("meeting.start", { meetingId: "meeting-yuqian" }, 1),
      ).nextState;
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});
