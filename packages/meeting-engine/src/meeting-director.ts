import type {
  MeetingAgendaItem,
  MeetingPlayerAction,
  MeetingPlayerActionType,
  MeetingSessionState,
  MeetingTurnRecord,
} from "@mandate/domain";
import { MeetingEngineError } from "./errors";
import {
  scheduleNextSpeaker,
  type SpeakerCandidateInput,
  type SpeakerSchedulingResult,
} from "./speaker-scheduler";

/**
 * Meeting Director（§八，ADR-016）。
 * 纯确定性编排器：根据会议状态、议程、上限与调度评分决定下一步。
 * 不调用 LLM、不写任何状态；LLM 调用与落库由 server 层按决策执行。
 *
 * 约定：管理类玩家动作（授予/剥夺发言权、暂停、延后议程、裁决、结束）由
 * service 直接执行后再询问 Director；只有对话类动作作为 lastPlayerAction 传入。
 */

export type CharacterResponseMode = "speech" | "answer" | "rebuttal" | "warning";

export type MeetingDirectorDecision =
  | {
      readonly type: "request-player-action";
      readonly allowedActions: readonly MeetingPlayerActionType[];
      readonly reason: string;
    }
  | {
      readonly type: "request-character-response";
      readonly characterId: string;
      readonly responseMode: CharacterResponseMode;
      readonly addressedCharacterIds: readonly string[];
      readonly reason: string;
    }
  | { readonly type: "advance-agenda"; readonly nextAgendaItemId: string; readonly reason: string }
  | { readonly type: "prepare-decision"; readonly agendaItemId: string; readonly reason: string }
  | { readonly type: "conclude-meeting"; readonly reason: string };

export interface MeetingDirectorInput {
  readonly session: MeetingSessionState;
  readonly agenda: readonly MeetingAgendaItem[];
  readonly recentTurns: readonly MeetingTurnRecord[];
  /** 已按参与者构建好的调度候选（含资格输入与模板） */
  readonly candidates: readonly SpeakerCandidateInput[];
  /** 对话类玩家动作（管理类动作不经 Director） */
  readonly lastPlayerAction?: MeetingPlayerAction;
}

export interface MeetingDirectorResult {
  readonly decision: MeetingDirectorDecision;
  readonly scheduling?: SpeakerSchedulingResult;
}

const PLAYER_DIALOG_ACTIONS: readonly MeetingPlayerActionType[] = [
  "address-meeting",
  "ask-character",
  "ask-open-question",
  "request-rebuttal",
  "interrupt-character",
  "open-next-agenda",
];

const LIMIT_REACHED_ACTIONS: readonly MeetingPlayerActionType[] = [
  "issue-ruling",
  "defer-agenda",
  "conclude-meeting",
];

function trailingCount(
  turns: readonly MeetingTurnRecord[],
  predicate: (turn: MeetingTurnRecord) => boolean,
): number {
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (!predicate(turns[index]!)) break;
    count++;
  }
  return count;
}

const AGENDA_TERMINAL = new Set(["resolved", "deferred", "rejected", "cancelled"]);

export function planNextStep(input: MeetingDirectorInput): MeetingDirectorResult {
  const { session, agenda, recentTurns } = input;

  if (session.status !== "in-progress" && session.status !== "waiting-for-player") {
    throw new MeetingEngineError(
      "MEETING_INVALID_STATE",
      `Director 不能在状态 ${session.status} 下规划`,
    );
  }
  if (session.pendingAgentAction) {
    throw new MeetingEngineError(
      "MEETING_AGENT_REQUEST_PENDING",
      "存在未完成的 Agent 回合，须先恢复或取消",
    );
  }

  const currentAgenda = agenda.find(
    (item) => item.agendaItemId === session.currentAgendaItemId,
  );

  // 1. 对话类玩家动作的直接后续
  const action = input.lastPlayerAction;
  if (action) {
    if (action.type === "ask-character") {
      return {
        decision: {
          type: "request-character-response",
          characterId: action.characterId,
          responseMode: "answer",
          addressedCharacterIds: ["emperor"],
          reason: "皇帝点名垂询",
        },
      };
    }
    if (action.type === "request-rebuttal") {
      return {
        decision: {
          type: "request-character-response",
          characterId: action.characterId,
          responseMode: "rebuttal",
          addressedCharacterIds: [action.targetCharacterId],
          reason: "皇帝命其回应他人意见",
        },
      };
    }
    if (action.type === "interrupt-character") {
      return {
        decision: {
          type: "request-player-action",
          allowedActions: PLAYER_DIALOG_ACTIONS,
          reason: "发言已被打断，请示下一步",
        },
      };
    }
    if (action.type === "open-next-agenda") {
      const next = nextQueuedAgenda(agenda);
      if (!next) {
        return {
          decision: { type: "conclude-meeting", reason: "已无未议之程，可以散朝" },
        };
      }
      return {
        decision: {
          type: "advance-agenda",
          nextAgendaItemId: next.agendaItemId,
          reason: "圣意进入下一议程",
        },
      };
    }
    // address-meeting / ask-open-question：落回调度，由最相关者应答
  }

  // 2. 上限检查（§9.3）
  if (session.usedTurns >= session.limits.maxTurns) {
    return {
      decision: {
        type: "request-player-action",
        allowedActions: LIMIT_REACHED_ACTIONS,
        reason: "会议回合已达上限，请圣裁：裁决、延后或散会",
      },
    };
  }
  const consecutiveAgentTurns = trailingCount(recentTurns, (turn) =>
    turn.type.startsWith("character-"),
  );
  if (consecutiveAgentTurns >= session.limits.maxConsecutiveAgentTurns) {
    return {
      decision: {
        type: "request-player-action",
        allowedActions: PLAYER_DIALOG_ACTIONS,
        reason: "群臣已连番陈奏，请陛下垂示",
      },
    };
  }
  const consecutiveRebuttals = trailingCount(
    recentTurns,
    (turn) => turn.type === "character-rebuttal",
  );
  if (consecutiveRebuttals >= session.limits.maxConsecutiveRebuttals) {
    return {
      decision: {
        type: "request-player-action",
        allowedActions: [...PLAYER_DIALOG_ACTIONS, "issue-ruling"],
        reason: "廷辩往复已多，请陛下约束或裁断",
      },
    };
  }

  // 3. 议程推进
  if (!currentAgenda) {
    const next = nextQueuedAgenda(agenda);
    if (next) {
      return {
        decision: {
          type: "advance-agenda",
          nextAgendaItemId: next.agendaItemId,
          reason: "进入下一项议程",
        },
      };
    }
    if (agenda.every((item) => AGENDA_TERMINAL.has(item.status))) {
      return { decision: { type: "conclude-meeting", reason: "全部议程已了，可以散朝" } };
    }
    return {
      decision: {
        type: "request-player-action",
        allowedActions: LIMIT_REACHED_ACTIONS,
        reason: "议程状态待圣裁",
      },
    };
  }
  if (currentAgenda.status === "decision-pending") {
    return {
      decision: {
        type: "request-player-action",
        allowedActions: ["issue-ruling", "defer-agenda"],
        reason: "本议已入裁决，请陛下降旨",
      },
    };
  }
  if (currentAgenda.usedTurns >= currentAgenda.maxTurns) {
    return {
      decision: {
        type: "prepare-decision",
        agendaItemId: currentAgenda.agendaItemId,
        reason: "本议回合已满，进入裁决",
      },
    };
  }

  // 4. 确定性调度发言者
  const scheduling = scheduleNextSpeaker(session, currentAgenda, input.candidates);
  if (scheduling.selected) {
    const responseMode: CharacterResponseMode =
      action && (action.type === "address-meeting" || action.type === "ask-open-question")
        ? "answer"
        : "speech";
    return {
      decision: {
        type: "request-character-response",
        characterId: scheduling.selected.characterId,
        responseMode,
        addressedCharacterIds: ["emperor"],
        reason: `调度评分最高（${scheduling.selected.total}）`,
      },
      scheduling,
    };
  }
  return {
    decision: {
      type: "request-player-action",
      allowedActions: [...PLAYER_DIALOG_ACTIONS, ...LIMIT_REACHED_ACTIONS],
      reason: "当前无合格发言者，请圣裁",
    },
    scheduling,
  };
}

function nextQueuedAgenda(
  agenda: readonly MeetingAgendaItem[],
): MeetingAgendaItem | undefined {
  return [...agenda]
    .filter((item) => item.status === "queued")
    .sort((a, b) => a.sequence - b.sequence || a.agendaItemId.localeCompare(b.agendaItemId))[0];
}
