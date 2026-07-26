import { ApiResponseMetaSchema, type MeetingPlayerAction } from "@mandate/domain";
import { z } from "zod";
import { apiClient } from "./client";

/** 会议 API 客户端（开发者 Meeting Lab 用；服务端结构演进期宽松解析 data） */

const Envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), meta: ApiResponseMetaSchema })
  .strict();

async function get(path: string) {
  return (await apiClient.get(path, Envelope)).data;
}
async function post(path: string, body: unknown) {
  return (await apiClient.post(path, body, Envelope)).data;
}

const enc = encodeURIComponent;

export interface MeetingSessionSummary {
  meetingId: string;
  type: string;
  status: string;
  title: string;
  meetingVersion: number;
  turnNumber: number;
  participantIds: string[];
  currentAgendaItemId?: string;
  currentSpeakerId?: string;
  pendingPlayerAction?: { allowedActions: string[]; reason: string };
  usedTurns: number;
}

export function listMeetings(saveId: string) {
  return get(`/api/saves/${enc(saveId)}/meetings`) as Promise<MeetingSessionSummary[]>;
}

export function getMeeting(saveId: string, meetingId: string) {
  return get(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}`) as Promise<{
    session: MeetingSessionSummary;
    participants: unknown[];
    agenda: Array<{ agendaItemId: string; title: string; status: string }>;
  }>;
}

export function createMeeting(saveId: string, payload: unknown) {
  return post(`/api/saves/${enc(saveId)}/meetings`, payload) as Promise<MeetingSessionSummary>;
}

export function addAgenda(saveId: string, meetingId: string, payload: unknown) {
  return post(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/agenda`, payload);
}

export function startMeeting(saveId: string, meetingId: string, payload: unknown) {
  return post(
    `/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/start`,
    payload,
  ) as Promise<MeetingSessionSummary>;
}

export interface StepResult {
  session: MeetingSessionSummary;
  decisionType: string;
  reason: string;
  newTurn?: { speakerId: string; publicText: string; type: string; turnNumber: number };
  scheduling?: unknown;
  acceptedCommands?: number;
}

export function stepMeeting(saveId: string, meetingId: string, payload: unknown) {
  return post(
    `/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/step`,
    payload,
  ) as Promise<StepResult>;
}

export function submitAction(
  saveId: string,
  meetingId: string,
  payload: {
    expectedRevision: number;
    expectedMeetingVersion: number;
    action: MeetingPlayerAction;
  },
) {
  return post(
    `/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/actions`,
    payload,
  ) as Promise<StepResult>;
}

export function issueRuling(saveId: string, meetingId: string, payload: unknown) {
  return post(
    `/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/rulings`,
    payload,
  ) as Promise<StepResult>;
}

export function concludeMeeting(saveId: string, meetingId: string, payload: unknown) {
  return post(
    `/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/conclude`,
    payload,
  ) as Promise<StepResult>;
}

export function pauseMeeting(saveId: string, meetingId: string, reason?: string) {
  return post(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/pause`, { reason });
}

export function resumeMeeting(saveId: string, meetingId: string) {
  return post(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/resume`, {});
}

export interface MeetingTurnView {
  turnId: string;
  turnNumber: number;
  type: string;
  speakerId: string;
  publicText: string;
  agendaItemId?: string;
  visibility: string;
  providerTrace?: { provider: string; durationMs: number; repaired: boolean };
  sourceTurnIds: string[];
}

export function listTurns(saveId: string, meetingId: string) {
  return get(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/turns?limit=200`) as Promise<{
    turns: MeetingTurnView[];
    nextCursor: number | null;
  }>;
}

export interface OutcomeView {
  outcomeCandidateId: string;
  agendaItemId: string;
  type: string;
  title: string;
  summary: string;
  status: string;
  unsupportedCommand: boolean;
  proposerIds: string[];
}

export function listOutcomes(saveId: string, meetingId: string) {
  return get(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/outcomes`) as Promise<
    OutcomeView[]
  >;
}

export function listMinutes(saveId: string, meetingId: string) {
  return get(`/api/saves/${enc(saveId)}/meetings/${enc(meetingId)}/minutes`);
}

export function getDebugLeak(saveId: string, meetingId: string) {
  return get(`/api/debug/saves/${enc(saveId)}/meetings/${enc(meetingId)}/leak`);
}
