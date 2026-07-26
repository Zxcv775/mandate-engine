import type { SaveMetadata } from "@mandate/domain";
import { createStore } from "zustand/vanilla";
import { ApiClientError } from "../api/client";
import { listCharacters } from "../api/characters";
import { getSaveState, listSaves } from "../api/saves";
import {
  advanceTime,
  adjustPolicy,
  decidePolicy,
  getDebugPolicyTruth,
  getDebugRuleTrace,
  getPolicy,
  issuePolicy,
  lifecyclePolicy,
  listPolicies,
  listPolicyReports,
  listPolicyTemplates,
  proposePolicy,
  type PolicyReportView,
  type PolicyTemplateSummary,
  type PolicyView,
} from "../api/policies";

/** Policy Lab 状态（开发者调试台）。所有写操作携带 expectedRevision（乐观锁）。 */

export interface PolicyLabState {
  saves: readonly SaveMetadata[];
  selectedSaveId?: string;
  headRevision?: number;
  treasuryTaels?: number;
  grainReserveShi?: number;
  currentTick?: number;
  templates: readonly PolicyTemplateSummary[];
  characters: readonly { characterId: string; name: string }[];
  policies: readonly PolicyView[];
  selected?: PolicyView;
  reports: readonly PolicyReportView[];
  truth?: unknown;
  ruleTrace?: unknown;
  busy: boolean;
  error?: string;
  // 表单
  templateId: string;
  assigneeId: string;
  budgetTaels: string;
  advanceDays: string;

  refreshSaves(): Promise<void>;
  selectSave(saveId: string): Promise<void>;
  refresh(): Promise<void>;
  selectPolicy(policyId: string): Promise<void>;
  setField(field: "templateId" | "assigneeId" | "budgetTaels" | "advanceDays", value: string): void;
  propose(): Promise<void>;
  decide(decision: "approve" | "reject"): Promise<void>;
  issue(): Promise<void>;
  adjust(): Promise<void>;
  lifecycle(action: "suspend" | "resume" | "cancel"): Promise<void>;
  advance(): Promise<void>;
  loadDebug(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : "未知错误";
}

export const policyLabStore = createStore<PolicyLabState>()((set, get) => {
  async function refreshHead(saveId: string): Promise<number> {
    const state = (await getSaveState(saveId)) as {
      revision: number;
      tick?: number;
      country?: { treasuryTaels: number; grainReserveShi: number };
    };
    set({
      headRevision: state.revision,
      currentTick: state.tick,
      treasuryTaels: state.country?.treasuryTaels,
      grainReserveShi: state.country?.grainReserveShi,
    });
    return state.revision;
  }

  async function guarded(run: () => Promise<void>) {
    set({ busy: true, error: undefined });
    try {
      await run();
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      set({ busy: false });
    }
  }

  return {
    saves: [],
    templates: [],
    characters: [],
    policies: [],
    reports: [],
    busy: false,
    templateId: "",
    assigneeId: "",
    budgetTaels: "",
    advanceDays: "1",

    async refreshSaves() {
      await guarded(async () => {
        set({ saves: await listSaves() });
      });
    },

    async selectSave(saveId) {
      await guarded(async () => {
        set({
          selectedSaveId: saveId,
          selected: undefined,
          reports: [],
          truth: undefined,
          ruleTrace: undefined,
        });
        await refreshHead(saveId);
        const [templates, characters, policies] = await Promise.all([
          listPolicyTemplates(saveId),
          listCharacters(saveId),
          listPolicies(saveId),
        ]);
        set({
          templates,
          characters: characters.map((character) => ({
            characterId: character.characterId,
            name: character.name,
          })),
          policies,
          templateId: templates[0]?.id ?? "",
          assigneeId: characters[0]?.characterId ?? "",
        });
      });
    },

    async refresh() {
      const { selectedSaveId, selected } = get();
      if (!selectedSaveId) return;
      await refreshHead(selectedSaveId);
      set({ policies: await listPolicies(selectedSaveId) });
      if (selected) {
        set({ selected: await getPolicy(selectedSaveId, selected.policyId) });
        set({
          reports: (await listPolicyReports(selectedSaveId, selected.policyId)).reports,
        });
      }
    },

    async selectPolicy(policyId) {
      await guarded(async () => {
        const saveId = get().selectedSaveId!;
        set({
          selected: await getPolicy(saveId, policyId),
          truth: undefined,
          ruleTrace: undefined,
        });
        set({ reports: (await listPolicyReports(saveId, policyId)).reports });
      });
    },

    setField(field, value) {
      set({ [field]: value } as Partial<PolicyLabState>);
    },

    async propose() {
      await guarded(async () => {
        const { selectedSaveId, templateId, headRevision } = get();
        const policy = await proposePolicy(selectedSaveId!, {
          templateId,
          expectedRevision: headRevision!,
        });
        await get().refresh();
        await get().selectPolicy(policy.policyId);
      });
    },

    async decide(decision) {
      await guarded(async () => {
        const { selectedSaveId, selected, headRevision } = get();
        await decidePolicy(selectedSaveId!, selected!.policyId, {
          decision,
          expectedRevision: headRevision!,
          ...(decision === "reject" ? { reason: "所奏不准" } : {}),
        });
        await get().refresh();
      });
    },

    async issue() {
      await guarded(async () => {
        const { selectedSaveId, selected, headRevision, assigneeId, budgetTaels, templates } =
          get();
        const template = templates.find((candidate) => candidate.id === selected!.templateId);
        const budget = Number(budgetTaels);
        await issuePolicy(selectedSaveId!, selected!.policyId, {
          expectedRevision: headRevision!,
          responsibleInstitutionId: template?.responsibleInstitutionId ?? "",
          responsibleCharacterIds: [assigneeId],
          ...(Number.isFinite(budget) && budget > 0
            ? { additionalBudget: { treasuryTaels: budget } }
            : {}),
        });
        await get().refresh();
      });
    },

    async adjust() {
      await guarded(async () => {
        const { selectedSaveId, selected, headRevision, budgetTaels } = get();
        const budget = Number(budgetTaels);
        await adjustPolicy(selectedSaveId!, selected!.policyId, {
          expectedRevision: headRevision!,
          additionalBudget: { treasuryTaels: Number.isFinite(budget) && budget > 0 ? budget : 0 },
          reason: "追加预算（Lab）",
        });
        await get().refresh();
      });
    },

    async lifecycle(action) {
      await guarded(async () => {
        const { selectedSaveId, selected, headRevision } = get();
        await lifecyclePolicy(selectedSaveId!, selected!.policyId, action, {
          expectedRevision: headRevision!,
          reason: action === "cancel" ? "圣意罢行（Lab）" : `${action}（Lab）`,
        });
        await get().refresh();
      });
    },

    async advance() {
      await guarded(async () => {
        const { selectedSaveId, headRevision, advanceDays } = get();
        const days = Math.max(1, Math.min(365, Number(advanceDays) || 1));
        await advanceTime(selectedSaveId!, {
          commandId: `cmd_lab_advance_${Date.now()}`,
          baseRevision: headRevision!,
          days,
        });
        await get().refresh();
      });
    },

    async loadDebug() {
      await guarded(async () => {
        const { selectedSaveId, selected } = get();
        set({
          truth: await getDebugPolicyTruth(selectedSaveId!, selected!.policyId),
          ruleTrace: await getDebugRuleTrace(selectedSaveId!, selected!.policyId),
        });
      });
    },
  };
});
