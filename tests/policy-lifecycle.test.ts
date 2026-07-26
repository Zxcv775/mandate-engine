import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameCommand, PolicyLifecycleStatus, PolicyRuntimeState } from "@mandate/domain";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, describePolicyTransitionMatrix, transitionPolicy } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

/** §21.2/21.3 政策状态机全矩阵 + policy.* 命令链路（成功/失败/幂等/乐观锁/revision/审计）。 */

const ALL_STATUSES: readonly PolicyLifecycleStatus[] = [
  "draft",
  "proposed",
  "approved",
  "issued",
  "implementing",
  "blocked",
  "partially-implemented",
  "suspended",
  "completed",
  "failed",
  "cancelled",
];

function makePolicy(status: PolicyLifecycleStatus): PolicyRuntimeState {
  return {
    policyId: "policy-1",
    templateId: "policy-zhenji-shaanxi",
    status,
    createdTick: 0,
    createdAtRevision: 1,
    responsibleCharacterIds: [],
    currentStageIndex: 0,
    stageProgress: 0,
    overallProgress: 0,
    investedResources: { treasuryTaels: 0, grainReserveShi: 0 },
    remainingBudget: { treasuryTaels: 0, grainReserveShi: 0 },
    origin: { kind: "direct-decree" },
    legitimacyCostAccrued: 0,
    sourceIds: [],
  };
}

describe("政策状态机全矩阵（ADR-023）", () => {
  const matrix = describePolicyTransitionMatrix();
  const events = Object.keys(matrix);

  it("矩阵覆盖全部 14 个事件", () => {
    expect(events).toHaveLength(14);
  });

  for (const eventType of events) {
    const rule = matrix[eventType]!;
    it(`${eventType}：允许自 ${rule.allowedFrom.join("/")}，其余全部拒绝`, () => {
      for (const status of ALL_STATUSES) {
        const policy = makePolicy(status);
        const event =
          eventType === "policy.resume"
            ? ({ type: "policy.resume", to: "implementing" } as const)
            : ({ type: eventType, reason: "测试" } as never);
        if (rule.allowedFrom.includes(status)) {
          const result = transitionPolicy(policy, event);
          expect(result.from).toBe(status);
          expect(ALL_STATUSES).toContain(result.to);
        } else {
          expect(() => transitionPolicy(policy, event)).toThrowError(
            expect.objectContaining({ code: "POLICY_TRANSITION_INVALID" }),
          );
        }
      }
    });
  }

  it("终态（completed/failed/cancelled）对一切事件不可复活", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      for (const eventType of events) {
        const event =
          eventType === "policy.resume"
            ? ({ type: "policy.resume", to: "implementing" } as const)
            : ({ type: eventType, reason: "测试" } as never);
        expect(() => transitionPolicy(makePolicy(terminal), event)).toThrowError(
          expect.objectContaining({ code: "POLICY_TRANSITION_INVALID" }),
        );
      }
    }
  });
});

describe("policy.* 白名单命令（§8.2）", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.();
  });

  async function setup(): Promise<SaveSystem> {
    const directory = await mkdtemp(join(tmpdir(), "mandate-policy-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const system = createSaveSystem({
      databasePath: join(directory, "save.sqlite"),
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(FIXTURE_NOW),
    });
    cleanup.push(() => system.close());
    await system.service.createSave({
      saveId: "save_policy",
      scenarioId: "chongzhen-early",
      title: "政策测试",
      seed: "policy-seed",
    });
    return system;
  }

  function command(
    commandType: GameCommand["commandType"],
    baseRevision: number,
    payload: Record<string, unknown>,
    extra: Partial<GameCommand> = {},
  ): GameCommand {
    return {
      commandId: `cmd_${commandType}_${baseRevision}`,
      commandType,
      saveId: "save_policy",
      baseRevision,
      actor: { type: "player", id: "player" },
      payload,
      createdAt: FIXTURE_NOW,
      ...extra,
    } as GameCommand;
  }

  async function proposeAndApprove(system: SaveSystem): Promise<number> {
    await system.service.commitCommand(
      command("policy.propose", 0, {
        policyId: "p1",
        templateId: "policy-zhenji-shaanxi",
        origin: { kind: "direct-decree" },
      }),
    );
    await system.service.commitCommand(command("policy.approve", 1, { policyId: "p1" }));
    return 2;
  }

  it("propose：创建 proposed 实例，恰好 revision+1，入 StateChangeLog", async () => {
    const system = await setup();
    const result = await system.service.commitCommand(
      command("policy.propose", 0, {
        policyId: "p1",
        templateId: "policy-zhenji-shaanxi",
        origin: { kind: "direct-decree" },
      }),
    );
    expect(result.revision).toBe(1);
    const state = await system.service.loadState("save_policy");
    expect(state.policies.p1).toMatchObject({
      status: "proposed",
      templateId: "policy-zhenji-shaanxi",
      origin: { kind: "direct-decree" },
    });
    const changes = await system.service.listChanges("save_policy", {});
    expect(
      changes.some((entry) => entry.path === "/policies/p1" && entry.operation === "add"),
    ).toBe(true);
  });

  it("propose：模板不存在拒绝；重复 policyId 拒绝；revision 不变", async () => {
    const system = await setup();
    await expect(
      system.service.commitCommand(
        command("policy.propose", 0, {
          policyId: "bad",
          templateId: "policy-nonexistent",
          origin: { kind: "direct-decree" },
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_TEMPLATE_NOT_FOUND" });
    await proposeAndApprove(system);
    await expect(
      system.service.commitCommand(
        command("policy.propose", 2, {
          policyId: "p1",
          templateId: "policy-zhenji-shaanxi",
          origin: { kind: "direct-decree" },
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_STATUS_INVALID" });
    expect((await system.service.loadState("save_policy")).revision).toBe(2);
  });

  it("直诏 approve：合法性规则生效（legitimacy 扣减 + 阻力 Modifier 入账）", async () => {
    const system = await setup();
    const before = await system.service.loadState("save_policy");
    await proposeAndApprove(system);
    const state = await system.service.loadState("save_policy");
    expect(state.policies.p1!.status).toBe("approved");
    // 模板 baseImpact +3 与直诏规则 -2 依序结算
    expect(state.country.legitimacy).toBe(before.country.legitimacy + 3 - 2);
    const modifiers = Object.values(state.modifiers);
    expect(
      modifiers.some(
        (modifier) =>
          modifier.target.kind === "policy" &&
          modifier.metric === "resistance" &&
          modifier.operation === "add",
      ),
    ).toBe(true);
  });

  it("issue：责任机构必须匹配模板；负责人须任允许官职；国库预检", async () => {
    const system = await setup();
    await proposeAndApprove(system);

    await expect(
      system.service.commitCommand(
        command("policy.issue", 2, {
          policyId: "p1",
          responsibleInstitutionId: "bing-bu",
          responsibleCharacterIds: ["huang-liji"],
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_ASSIGNEE_INVALID" });

    // huang-liji 任内阁首辅（nei-ge-shou-fu ∈ allowedOfficeIds）
    const issued = await system.service.commitCommand(
      command("policy.issue", 2, {
        policyId: "p1",
        responsibleInstitutionId: "hu-bu",
        responsibleCharacterIds: ["huang-liji"],
        additionalBudget: { treasuryTaels: 30_000 },
      }),
    );
    expect(issued.revision).toBe(3);
    const state = await system.service.loadState("save_policy");
    expect(state.policies.p1).toMatchObject({
      status: "issued",
      responsibleInstitutionId: "hu-bu",
      investedResources: { treasuryTaels: 120_000, grainReserveShi: 80_000 },
      remainingBudget: { treasuryTaels: 30_000, grainReserveShi: 0 },
    });
    expect(state.hidden.policyTruth.p1).toMatchObject({
      realOverallProgress: 0,
      corruptionAccruedTaels: 0,
    });
  });

  it("issue：国库不足 POLICY_COST_INSUFFICIENT 且整体回滚", async () => {
    const system = await setup();
    await proposeAndApprove(system);
    await expect(
      system.service.commitCommand(
        command("policy.issue", 2, {
          policyId: "p1",
          responsibleInstitutionId: "hu-bu",
          responsibleCharacterIds: ["huang-liji"],
          additionalBudget: { treasuryTaels: 999_999_999 },
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_COST_INSUFFICIENT" });
    const state = await system.service.loadState("save_policy");
    expect(state.revision).toBe(2);
    expect(state.policies.p1!.status).toBe("approved");
  });

  it("同 idempotencyKey 重放返回相同结果，不产生第二次变更", async () => {
    const system = await setup();
    const first = await system.service.commitCommand(
      command(
        "policy.propose",
        0,
        {
          policyId: "p1",
          templateId: "policy-zhenji-shaanxi",
          origin: { kind: "direct-decree" },
        },
        { idempotencyKey: "propose-p1" },
      ),
    );
    const replay = await system.service.commitCommand(
      command(
        "policy.propose",
        0,
        {
          policyId: "p1",
          templateId: "policy-zhenji-shaanxi",
          origin: { kind: "direct-decree" },
        },
        { idempotencyKey: "propose-p1", commandId: "cmd_replay" },
      ),
    );
    expect(replay.revision).toBe(first.revision);
    expect((await system.service.loadState("save_policy")).revision).toBe(1);
  });

  it("stale baseRevision 返回 STATE_REVISION_CONFLICT", async () => {
    const system = await setup();
    await proposeAndApprove(system);
    await expect(
      system.service.commitCommand(command("policy.approve", 0, { policyId: "p1" })),
    ).rejects.toMatchObject({ code: "STATE_REVISION_CONFLICT" });
  });

  it("reject/suspend/resume/cancel 全链：状态、沉没成本与合法性代价", async () => {
    const system = await setup();
    await proposeAndApprove(system);
    await system.service.commitCommand(
      command("policy.issue", 2, {
        policyId: "p1",
        responsibleInstitutionId: "hu-bu",
        responsibleCharacterIds: ["huang-liji"],
        additionalBudget: { treasuryTaels: 10_000 },
      }),
    );
    await system.service.commitCommand(
      command("policy.suspend", 3, { policyId: "p1", reason: "廷议未决，暂缓" }),
    );
    let state = await system.service.loadState("save_policy");
    expect(state.policies.p1!.status).toBe("suspended");

    await system.service.commitCommand(command("policy.resume", 4, { policyId: "p1" }));
    state = await system.service.loadState("save_policy");
    // 从未结算过 → 回到 issued
    expect(state.policies.p1!.status).toBe("issued");

    const treasuryBefore = state.country.treasuryTaels;
    const legitimacyBefore = state.country.legitimacy;
    await system.service.commitCommand(
      command("policy.cancel", 5, { policyId: "p1", reason: "灾情缓解，罢赈" }),
    );
    state = await system.service.loadState("save_policy");
    expect(state.policies.p1!.status).toBe("cancelled");
    // 未耗预算退还；已颁行废止有合法性代价（politicalCost 6 → -3）
    expect(state.country.treasuryTaels).toBe(treasuryBefore + 10_000);
    expect(state.country.legitimacy).toBe(legitimacyBefore - 3);

    // 终态不可复活
    await expect(
      system.service.commitCommand(command("policy.approve", 6, { policyId: "p1" })),
    ).rejects.toMatchObject({ code: "POLICY_ALREADY_DECIDED" });

    // reject 路径独立验证
    await system.service.commitCommand(
      command("policy.propose", 6, {
        policyId: "p2",
        templateId: "policy-zhenji-shaanxi",
        origin: { kind: "direct-decree" },
      }),
    );
    await system.service.commitCommand(
      command("policy.reject", 7, { policyId: "p2", reason: "所奏不准" }),
    );
    state = await system.service.loadState("save_policy");
    expect(state.policies.p2!.status).toBe("cancelled");
  });

  it("adjust：追加预算解除资源阻滞；非法负责人拒绝", async () => {
    const system = await setup();
    await proposeAndApprove(system);
    await system.service.commitCommand(
      command("policy.issue", 2, {
        policyId: "p1",
        responsibleInstitutionId: "hu-bu",
        responsibleCharacterIds: ["huang-liji"],
      }),
    );
    await expect(
      system.service.commitCommand(
        command("policy.adjust", 3, {
          policyId: "p1",
          responsibleCharacterIds: ["nobody"],
          reason: "换人",
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_ASSIGNEE_INVALID" });
    const adjusted = await system.service.commitCommand(
      command("policy.adjust", 3, {
        policyId: "p1",
        additionalBudget: { treasuryTaels: 5_000 },
        reason: "加拨赈银",
      }),
    );
    expect(adjusted.revision).toBe(4);
    const state = await system.service.loadState("save_policy");
    expect(state.policies.p1!.remainingBudget.treasuryTaels).toBe(5_000);
  });
});
