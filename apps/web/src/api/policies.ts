import { ApiResponseMetaSchema } from "@mandate/domain";
import { z } from "zod";
import { apiClient } from "./client";

/** 政策 API 客户端（开发者 Policy Lab 用；服务端结构演进期宽松解析 data） */

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

export interface PolicyTemplateSummary {
  id: string;
  name: string;
  category: string;
  summary: string;
  responsibleInstitutionId: string;
  allowedOfficeIds: string[];
  cost: {
    startup: Record<string, number>;
    upkeepPerTick: Record<string, number>;
  };
  duration: { estimatedTicks: number; stages: { stageId: string; title: string }[] };
}

export interface PolicyView {
  policyId: string;
  templateId: string;
  templateName?: string;
  category?: string;
  status: string;
  currentStageIndex: number;
  stageProgress: number;
  overallProgress: number;
  responsibleInstitutionId?: string;
  responsibleCharacterIds: string[];
  investedResources: { treasuryTaels: number; grainReserveShi: number };
  remainingBudget: { treasuryTaels: number; grainReserveShi: number };
  origin: { kind: string };
  blockedReason?: string;
  suspendedReason?: string;
  issuedTick?: number;
  lastResolutionTick?: number;
}

export interface PolicyReportView {
  reportId: string;
  tick: number;
  stageIndex: number;
  reportedStageProgress: number;
  reportedOverallProgress: number;
  text: string;
}

export function listPolicyTemplates(saveId: string) {
  return get(`/api/saves/${enc(saveId)}/policy-templates`) as Promise<PolicyTemplateSummary[]>;
}

export function listPolicies(saveId: string) {
  return get(`/api/saves/${enc(saveId)}/policies`) as Promise<PolicyView[]>;
}

export function getPolicy(saveId: string, policyId: string) {
  return get(`/api/saves/${enc(saveId)}/policies/${enc(policyId)}`) as Promise<PolicyView>;
}

export function proposePolicy(
  saveId: string,
  payload: { templateId: string; expectedRevision: number; reason?: string },
) {
  return post(`/api/saves/${enc(saveId)}/policies`, payload) as Promise<PolicyView>;
}

export function decidePolicy(
  saveId: string,
  policyId: string,
  payload: { decision: "approve" | "reject"; expectedRevision: number; reason?: string },
) {
  return post(
    `/api/saves/${enc(saveId)}/policies/${enc(policyId)}/decision`,
    payload,
  ) as Promise<PolicyView>;
}

export function issuePolicy(
  saveId: string,
  policyId: string,
  payload: {
    expectedRevision: number;
    responsibleInstitutionId: string;
    responsibleCharacterIds: string[];
    additionalBudget?: { treasuryTaels?: number; grainReserveShi?: number };
  },
) {
  return post(
    `/api/saves/${enc(saveId)}/policies/${enc(policyId)}/issue`,
    payload,
  ) as Promise<PolicyView>;
}

export function adjustPolicy(
  saveId: string,
  policyId: string,
  payload: {
    expectedRevision: number;
    additionalBudget?: { treasuryTaels?: number; grainReserveShi?: number };
    reason: string;
  },
) {
  return post(
    `/api/saves/${enc(saveId)}/policies/${enc(policyId)}/adjust`,
    payload,
  ) as Promise<PolicyView>;
}

export function lifecyclePolicy(
  saveId: string,
  policyId: string,
  action: "suspend" | "resume" | "cancel",
  payload: { expectedRevision: number; reason?: string },
) {
  return post(
    `/api/saves/${enc(saveId)}/policies/${enc(policyId)}/${action}`,
    payload,
  ) as Promise<PolicyView>;
}

export function listPolicyReports(saveId: string, policyId: string) {
  return get(`/api/saves/${enc(saveId)}/policies/${enc(policyId)}/reports?limit=20`) as Promise<{
    reports: PolicyReportView[];
    nextCursor: number | null;
  }>;
}

export function advanceTime(
  saveId: string,
  payload: { commandId: string; baseRevision: number; days: number },
) {
  return post(`/api/saves/${enc(saveId)}/time/advance`, payload) as Promise<{
    revision: number;
  }>;
}

export function getDebugPolicyTruth(saveId: string, policyId: string) {
  return get(`/api/debug/saves/${enc(saveId)}/policies/${enc(policyId)}/truth`);
}

export function getDebugRuleTrace(saveId: string, policyId: string) {
  return get(`/api/debug/saves/${enc(saveId)}/policies/${enc(policyId)}/rule-trace`);
}
