import type {
  AdjustPolicyRequest,
  GameCommand,
  IssuePolicyRequest,
  PolicyLifecycleActionRequest,
  PolicyLifecycleStatus,
  PolicyReport,
  PolicyReportsQuery,
  PolicyRuntimeState,
  PolicyTemplate,
  PolicyTruth,
  ProposePolicyRequest,
} from "@mandate/domain";
import type { ScenarioLoader } from "@mandate/data-loader";
import { createRuleRegistry, type RulePackManifestEntry } from "@mandate/rule-engine";
import type { GameStateService, PolicyDetailRepository } from "@mandate/save-system";
import type { PolicyDeviationLogRecord, PolicyStageResultRecord } from "@mandate/game-engine";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors/api-error";

/**
 * Policy Service（§12）：政策生命周期的应用服务层。
 * - 一切写操作经白名单 GameCommand → StateEngine（乐观锁 expectedRevision）；
 * - 玩家读到公开快照与公开奏报；hidden 真实态仅 Debug 方法暴露；
 * - LLM 零介入：直诏/御批为玩家动作，会议来源经裁决映射（meeting-service）。
 */

export interface PolicyServiceOptions {
  gameStateService: GameStateService;
  policyDetails: PolicyDetailRepository;
  scenarioLoader: ScenarioLoader;
  idFactory?: () => string;
  clock?: { now(): Date };
}

export interface PolicyView extends PolicyRuntimeState {
  templateName?: string;
  category?: string;
}

export class PolicyService {
  private readonly idFactory: () => string;
  private readonly clock: { now(): Date };
  private readonly templateCache = new Map<string, Promise<readonly PolicyTemplate[]>>();

  constructor(private readonly options: PolicyServiceOptions) {
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.clock = options.clock ?? { now: () => new Date() };
  }

  private async templates(saveId: string): Promise<readonly PolicyTemplate[]> {
    const metadata = await this.options.gameStateService.getSave(saveId);
    let cached = this.templateCache.get(metadata.scenarioId);
    if (!cached) {
      cached = this.options.scenarioLoader
        .loadScenarioBundle(metadata.scenarioId)
        .then((bundle) => structuredClone(bundle.policyTemplates) as PolicyTemplate[]);
      this.templateCache.set(metadata.scenarioId, cached);
    }
    return cached;
  }

  async listTemplates(saveId: string): Promise<readonly PolicyTemplate[]> {
    return this.templates(saveId);
  }

  async listPolicies(saveId: string, status?: PolicyLifecycleStatus): Promise<PolicyView[]> {
    const [state, templates] = await Promise.all([
      this.options.gameStateService.loadState(saveId),
      this.templates(saveId),
    ]);
    return Object.values(state.policies)
      .filter((policy) => (status === undefined ? true : policy.status === status))
      .sort((a, b) => a.policyId.localeCompare(b.policyId))
      .map((policy) => this.toView(policy, templates));
  }

  private toView(policy: PolicyRuntimeState, templates: readonly PolicyTemplate[]): PolicyView {
    const template = templates.find((candidate) => candidate.id === policy.templateId);
    return {
      ...policy,
      ...(template === undefined
        ? {}
        : { templateName: template.name, category: template.category }),
    };
  }

  async getPolicy(saveId: string, policyId: string): Promise<PolicyView> {
    const [state, templates] = await Promise.all([
      this.options.gameStateService.loadState(saveId),
      this.templates(saveId),
    ]);
    const policy = state.policies[policyId];
    if (!policy) {
      throw new ApiError(404, "POLICY_NOT_FOUND", `政策不存在：${policyId}`);
    }
    return this.toView(policy, templates);
  }

  private async commit(
    saveId: string,
    commandType: GameCommand["commandType"],
    baseRevision: number,
    payload: Record<string, unknown>,
  ): Promise<PolicyView> {
    const policyId = String(payload.policyId);
    await this.options.gameStateService.commitCommand({
      commandId: `cmd_${commandType.replace(/\./g, "_")}_${this.idFactory()}`,
      commandType,
      saveId,
      baseRevision,
      actor: { type: "player", id: "player" },
      payload,
      createdAt: this.clock.now().toISOString(),
    } as GameCommand);
    return this.getPolicy(saveId, policyId);
  }

  /** 直诏 propose（会议来源经裁决映射，不走本方法） */
  async propose(saveId: string, input: ProposePolicyRequest): Promise<PolicyView> {
    const policyId = input.policyId ?? `policy_${this.idFactory()}`;
    return this.commit(saveId, "policy.propose", input.expectedRevision, {
      policyId,
      templateId: input.templateId,
      origin: { kind: "direct-decree" },
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  async decide(
    saveId: string,
    policyId: string,
    input: { decision: "approve" | "reject"; expectedRevision: number; reason?: string },
  ): Promise<PolicyView> {
    if (input.decision === "approve") {
      return this.commit(saveId, "policy.approve", input.expectedRevision, {
        policyId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    }
    return this.commit(saveId, "policy.reject", input.expectedRevision, {
      policyId,
      reason: input.reason ?? "所奏不准",
    });
  }

  async issue(saveId: string, policyId: string, input: IssuePolicyRequest): Promise<PolicyView> {
    return this.commit(saveId, "policy.issue", input.expectedRevision, {
      policyId,
      responsibleInstitutionId: input.responsibleInstitutionId,
      responsibleCharacterIds: input.responsibleCharacterIds,
      ...(input.additionalBudget === undefined ? {} : { additionalBudget: input.additionalBudget }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  async adjust(saveId: string, policyId: string, input: AdjustPolicyRequest): Promise<PolicyView> {
    return this.commit(saveId, "policy.adjust", input.expectedRevision, {
      policyId,
      ...(input.additionalBudget === undefined ? {} : { additionalBudget: input.additionalBudget }),
      ...(input.responsibleCharacterIds === undefined
        ? {}
        : { responsibleCharacterIds: input.responsibleCharacterIds }),
      reason: input.reason,
    });
  }

  async suspend(
    saveId: string,
    policyId: string,
    input: PolicyLifecycleActionRequest,
  ): Promise<PolicyView> {
    return this.commit(saveId, "policy.suspend", input.expectedRevision, {
      policyId,
      reason: input.reason ?? "圣意暂缓",
    });
  }

  async resume(
    saveId: string,
    policyId: string,
    input: PolicyLifecycleActionRequest,
  ): Promise<PolicyView> {
    return this.commit(saveId, "policy.resume", input.expectedRevision, {
      policyId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  async cancel(
    saveId: string,
    policyId: string,
    input: PolicyLifecycleActionRequest,
  ): Promise<PolicyView> {
    return this.commit(saveId, "policy.cancel", input.expectedRevision, {
      policyId,
      reason: input.reason ?? "圣意罢行",
    });
  }

  /** 公开奏报（玩家视角；hidden 内档不经本方法） */
  async listReports(
    saveId: string,
    policyId: string,
    query: PolicyReportsQuery,
  ): Promise<{ reports: PolicyReport[]; nextCursor: number | null }> {
    await this.getPolicy(saveId, policyId);
    return this.options.policyDetails.listReports(saveId, policyId, {
      audience: "public",
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  // ---- Debug（生产 404）---------------------------------------------------

  async debugTruth(
    saveId: string,
    policyId: string,
  ): Promise<{
    truth: PolicyTruth | null;
    deviations: PolicyDeviationLogRecord[];
    hiddenReports: PolicyReport[];
  }> {
    const state = await this.options.gameStateService.loadState(saveId);
    if (!state.policies[policyId]) {
      throw new ApiError(404, "POLICY_NOT_FOUND", `政策不存在：${policyId}`);
    }
    return {
      truth: state.hidden.policyTruth[policyId] ?? null,
      deviations: this.options.policyDetails.listDeviations(saveId, policyId),
      hiddenReports: this.options.policyDetails.listReports(saveId, policyId, {
        audience: "hidden",
        limit: 50,
      }).reports,
    };
  }

  async debugRuleTrace(saveId: string, policyId: string): Promise<PolicyStageResultRecord[]> {
    await this.getPolicy(saveId, policyId);
    return this.options.policyDetails.listStageResults(saveId, policyId);
  }

  async debugRules(saveId: string): Promise<readonly RulePackManifestEntry[]> {
    const metadata = await this.options.gameStateService.getSave(saveId);
    const bundle = await this.options.scenarioLoader.loadScenarioBundle(metadata.scenarioId);
    return createRuleRegistry(structuredClone(bundle.rulePacks) as never).manifest;
  }
}
