import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameCommand, MeetingOutcomeCandidate } from "@mandate/domain";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock, hashState } from "@mandate/game-engine";
import { mapOutcomeToCommand } from "@mandate/meeting-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, makeFixtureState } from "./helpers/character-fixtures";

/** §21.5/21.6 执行结算：进度/维持成本/阻滞/偏差/奏报分离/确定性重放/回滚一致。 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function setup(saveId = "save_res", seed = "res-seed"): Promise<SaveSystem> {
  const directory = await mkdtemp(join(tmpdir(), "mandate-res-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const system = createSaveSystem({
    databasePath: join(directory, "save.sqlite"),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(() => system.close());
  await system.service.createSave({
    saveId,
    scenarioId: "chongzhen-early",
    title: "结算测试",
    seed,
  });
  return system;
}

function command(
  saveId: string,
  commandType: GameCommand["commandType"],
  baseRevision: number,
  payload: Record<string, unknown>,
): GameCommand {
  return {
    commandId: `cmd_${commandType}_${baseRevision}_${Math.abs(baseRevision * 7919)}`,
    commandType,
    saveId,
    baseRevision,
    actor: { type: "player", id: "player" },
    payload,
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

async function issuePolicy(system: SaveSystem, saveId: string): Promise<number> {
  await system.service.commitCommand(
    command(saveId, "policy.propose", 0, {
      policyId: "p1",
      templateId: "policy-zhenji-shaanxi",
      origin: { kind: "direct-decree" },
    }),
  );
  await system.service.commitCommand(command(saveId, "policy.approve", 1, { policyId: "p1" }));
  await system.service.commitCommand(
    command(saveId, "policy.issue", 2, {
      policyId: "p1",
      responsibleInstitutionId: "hu-bu",
      responsibleCharacterIds: ["huang-liji"],
      additionalBudget: { treasuryTaels: 20_000, grainReserveShi: 10_000 },
    }),
  );
  return 3;
}

async function advance(
  system: SaveSystem,
  saveId: string,
  baseRevision: number,
  days = 1,
): Promise<number> {
  const result = await system.service.advanceTime(saveId, {
    commandId: `cmd_adv_${baseRevision}`,
    baseRevision,
    days,
  });
  return result.revision;
}

describe("政策执行结算（ADR-025）", () => {
  it("推进 tick：进度增长、维持成本先扣预算、奏报/内档双记录、明细表落库", async () => {
    const system = await setup();
    const revision = await issuePolicy(system, "save_res");
    const before = await system.service.loadState("save_res");
    await advance(system, "save_res", revision);

    const state = await system.service.loadState("save_res");
    const policy = state.policies.p1!;
    expect(policy.status).toBe("implementing");
    expect(policy.stageProgress).toBeGreaterThan(0);
    expect(policy.lastResolutionTick).toBe(1);
    // 维持成本（800 银/600 粮）从政策预算扣，国库不再出账
    expect(policy.remainingBudget.treasuryTaels).toBe(20_000 - 800);
    expect(policy.remainingBudget.grainReserveShi).toBe(10_000 - 600);
    expect(state.country.treasuryTaels).toBe(before.country.treasuryTaels);
    // hidden 真实档案存在且玩家视图不可见
    expect(state.hidden.policyTruth.p1!.realStageProgress).toBeGreaterThan(0);
    const playerView = await system.service.loadPlayerState("save_res");
    expect(JSON.stringify(playerView)).not.toContain("policyTruth");

    // 明细表：结算 breakdown + 公开/内档奏报（同事务）
    const stageResults = system.policyDetails.listStageResults("save_res", "p1");
    expect(stageResults).toHaveLength(1);
    expect(stageResults[0]!.breakdown.coefficient).toBeGreaterThan(0);
    expect(stageResults[0]!.breakdown.coefficient).toBeLessThanOrEqual(1);
    const publicReports = system.policyDetails.listReports("save_res", "p1", {
      audience: "public",
    });
    const hiddenReports = system.policyDetails.listReports("save_res", "p1", {
      audience: "hidden",
    });
    expect(publicReports.reports).toHaveLength(1);
    expect(hiddenReports.reports).toHaveLength(1);
    expect(hiddenReports.reports[0]!.text).toContain("核实进度");
    expect(publicReports.reports[0]!.text).not.toContain("核实进度");
  });

  it("确定性：同 seed 同命令序列 → 状态哈希与结算明细逐 tick 一致", async () => {
    const runs: { hash: string; breakdowns: string; deviations: string }[] = [];
    for (let run = 0; run < 2; run++) {
      const system = await setup("save_det", "det-seed");
      let revision = await issuePolicy(system, "save_det");
      for (let day = 0; day < 5; day++) {
        revision = await advance(system, "save_det", revision);
      }
      const state = await system.service.loadState("save_det");
      runs.push({
        hash: hashState(state),
        breakdowns: JSON.stringify(
          system.policyDetails.listStageResults("save_det", "p1").map((r) => r.breakdown),
        ),
        deviations: JSON.stringify(system.policyDetails.listDeviations("save_det", "p1")),
      });
    }
    expect(runs[0]!.hash).toBe(runs[1]!.hash);
    expect(runs[0]!.breakdowns).toBe(runs[1]!.breakdowns);
    expect(runs[0]!.deviations).toBe(runs[1]!.deviations);
  });

  it("回滚后重推：政策与真实档案结果一致（派生 RNG 不动世界 cursor）", async () => {
    const system = await setup("save_rb", "rb-seed");
    let revision = await issuePolicy(system, "save_rb");
    const checkpointRevision = revision;
    revision = await advance(system, "save_rb", revision);
    const firstState = await system.service.loadState("save_rb");
    const firstPolicy = structuredClone(firstState.policies.p1);
    const firstTruth = structuredClone(firstState.hidden.policyTruth.p1);
    expect(firstState.rng.cursor).toBe(0);

    const rollback = await system.service.rollback("save_rb", {
      targetRevision: checkpointRevision,
    });
    expect(rollback.resultRevision).not.toBeNull();
    await advance(system, "save_rb", rollback.resultRevision!);
    const replayState = await system.service.loadState("save_rb");
    expect(replayState.policies.p1).toEqual(firstPolicy);
    expect(replayState.hidden.policyTruth.p1).toEqual(firstTruth);
    expect(replayState.rng.cursor).toBe(0);
  });

  it("钱粮断绝 → blocked；外部补资后的首 tick 正常付款再恢复推进", async () => {
    const system = await setup("save_blk", "blk-seed");
    let revision = await issuePolicy(system, "save_blk");
    let state = await system.service.loadState("save_blk");
    // 掏空政策预算之外的国库与粮储，并耗尽政策预算（连续推进 30 天将预算烧完）
    await system.service.commitCommand(
      command("save_blk", "country.adjust-resource", revision, {
        resource: "treasuryTaels",
        delta: -state.country.treasuryTaels,
        reason: "清空国库（测试）",
      }),
    );
    revision += 1;
    state = await system.service.loadState("save_blk");
    await system.service.commitCommand(
      command("save_blk", "country.adjust-resource", revision, {
        resource: "grainReserveShi",
        delta: -state.country.grainReserveShi,
        reason: "清空粮储（测试）",
      }),
    );
    revision += 1;
    // 预算 2 万银/1 万粮，每 tick 800+600：一次推进 30 天直接烧穿预算
    revision = await advance(system, "save_blk", revision, 30);
    state = await system.service.loadState("save_blk");
    // 30 天维持需 2.4 万银——预算只有 2 万，到位率 <1 但 >0，仍在推行；再推 30 天弹尽粮绝
    revision = await advance(system, "save_blk", revision, 30);
    state = await system.service.loadState("save_blk");
    expect(state.policies.p1!.status).toBe("blocked");
    expect(state.policies.p1!.blockedReason).toContain("钱粮");

    // 外部补充银粮，不走 policy.adjust；blocked 恢复的首 tick 必须重新计算并付款。
    await system.service.commitCommand(
      command("save_blk", "country.adjust-resource", revision, {
        resource: "treasuryTaels",
        delta: 200_000,
        reason: "发内帑（测试）",
      }),
    );
    revision += 1;
    await system.service.commitCommand(
      command("save_blk", "country.adjust-resource", revision, {
        resource: "grainReserveShi",
        delta: 200_000,
        reason: "开仓补粮（测试）",
      }),
    );
    revision += 1;
    const funded = await system.service.loadState("save_blk");
    const progressBefore = funded.policies.p1!.stageProgress;
    revision = await advance(system, "save_blk", revision);
    state = await system.service.loadState("save_blk");
    expect(state.policies.p1!.status).toBe("implementing");
    expect(state.policies.p1!.stageProgress).toBeGreaterThan(progressBefore);
    expect(state.country.treasuryTaels).toBe(funded.country.treasuryTaels - 800);
    expect(state.country.grainReserveShi).toBe(funded.country.grainReserveShi - 600);
  });

  it("偏差留痕：确定性触发进偏差日志，真实与奏报口径分离", async () => {
    const system = await setup("save_dev", "dev-seed");
    let revision = await issuePolicy(system, "save_dev");
    for (let day = 0; day < 25; day++) {
      revision = await advance(system, "save_dev", revision);
    }
    const deviations = system.policyDetails.listDeviations("save_dev", "p1");
    const state = await system.service.loadState("save_dev");
    const truth = state.hidden.policyTruth.p1!;
    // 25 tick × 6 类独立 roll（基础概率 3%~6%）：确定性流下必然命中若干
    expect(deviations.length).toBeGreaterThan(0);
    expect(truth.deviations.length).toBeGreaterThan(0);
    expect(truth.lastDeviationTick).toBeDefined();
    // 偏差流水与 hidden 摘要类型一致
    expect(new Set(truth.deviations.map((d) => d.type))).toEqual(
      new Set(deviations.map((d) => d.type)),
    );
  });

  it("行政容量按 policyId 稳定争用并进入统一占用账本", async () => {
    const system = await setup("save_capacity", "capacity-seed");
    let state = await system.service.loadState("save_capacity");
    let revision = 0;
    await system.service.commitCommand(
      command("save_capacity", "country.adjust-resource", revision, {
        resource: "administrativeCapacity",
        delta: 10 - state.country.administrativeCapacity,
        reason: "容量争用测试",
      }),
    );
    revision += 1;
    for (const policyId of ["p-a", "p-b"]) {
      await system.service.commitCommand(
        command("save_capacity", "policy.propose", revision++, {
          policyId,
          templateId: "policy-qinding-nian",
          origin: { kind: "direct-decree" },
        }),
      );
      await system.service.commitCommand(
        command("save_capacity", "policy.approve", revision++, { policyId }),
      );
      await system.service.commitCommand(
        command("save_capacity", "policy.issue", revision++, {
          policyId,
          responsibleInstitutionId: "nei-ge",
          responsibleCharacterIds: ["huang-liji"],
        }),
      );
    }
    await advance(system, "save_capacity", revision);
    const first = system.policyDetails.listStageResults("save_capacity", "p-a")[0]!;
    const second = system.policyDetails.listStageResults("save_capacity", "p-b")[0]!;
    expect(first.fundingRatio).toBe(1);
    expect(second.fundingRatio).toBeCloseTo(4 / 6);
    const ledger = system.policyDetails.listCostApplications("save_capacity");
    expect(ledger.filter((entry) => entry.resourceId === "administrativeCapacity")).toEqual([
      expect.objectContaining({
        policyId: "p-a",
        mode: "occupy",
        required: 6,
        applied: 6,
        before: 10,
        after: 4,
      }),
      expect.objectContaining({
        policyId: "p-b",
        mode: "occupy",
        required: 6,
        applied: 4,
        before: 4,
        after: 0,
      }),
    ]);
    state = await system.service.loadState("save_capacity");
    expect(state.country.administrativeCapacity).toBe(10);
  });
});

describe("会议候选 → policy.propose 白名单映射（ADR-019 扩展）", () => {
  const state = makeFixtureState();

  function candidate(preview?: Record<string, unknown>): MeetingOutcomeCandidate {
    return {
      outcomeCandidateId: "outcome_abc123",
      meetingId: "m1",
      saveId: state.saveId,
      agendaItemId: "ag1",
      type: "policy-proposal",
      title: "请行赈济",
      summary: "请依模板赈济陕西",
      proposerIds: ["huang-liji"],
      supporterIds: [],
      opponentIds: [],
      rationale: ["民饥则乱"],
      risks: [],
      sourceTurnIds: ["turn-1"],
      status: "presented",
      ...(preview === undefined ? {} : { commandPreview: preview as never }),
      unsupportedCommand: preview === undefined,
      createdAtRevision: 1,
      createdAt: FIXTURE_NOW,
    };
  }

  it("合法 propose-policy 候选映射为 policy.propose（会议来源）", () => {
    const result = mapOutcomeToCommand(
      candidate({
        commandType: "policy.propose",
        payload: { templateId: "policy-zhenji-shaanxi", reason: "众议佥同" },
      }),
      state,
      { policyTemplateIds: ["policy-zhenji-shaanxi"] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toMatchObject({
        commandType: "policy.propose",
        payload: {
          policyId: "policy_abc123",
          templateId: "policy-zhenji-shaanxi",
          origin: { kind: "meeting", meetingId: "m1", outcomeCandidateId: "outcome_abc123" },
        },
      });
    }
  });

  it("伪造 templateId / 未装载模板 / 额外字段全部拒绝", () => {
    expect(
      mapOutcomeToCommand(
        candidate({
          commandType: "policy.propose",
          payload: { templateId: "policy-forged-by-llm" },
        }),
        state,
        { policyTemplateIds: ["policy-zhenji-shaanxi"] },
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });
    expect(
      mapOutcomeToCommand(
        candidate({
          commandType: "policy.propose",
          payload: { templateId: "policy-zhenji-shaanxi", mutations: [{ path: "/hidden" }] },
        }),
        state,
        { policyTemplateIds: ["policy-zhenji-shaanxi"] },
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });
    // 上下文未提供模板清单 → 拒绝（保守失败）
    expect(
      mapOutcomeToCommand(
        candidate({
          commandType: "policy.propose",
          payload: { templateId: "policy-zhenji-shaanxi" },
        }),
        state,
      ),
    ).toMatchObject({ ok: false, code: "MEETING_OUTCOME_INVALID" });
  });
});

describe("政策明细随存档导入导出与 safe_share（§10）", () => {
  it("full 导出→导入保留明细；safe_share 剥离偏差/结算/内档奏报", async () => {
    const source = await setup("save_exp", "exp-seed");
    let revision = await issuePolicy(source, "save_exp");
    for (let day = 0; day < 10; day++) {
      revision = await advance(source, "save_exp", revision);
    }
    const stageCount = source.policyDetails.listStageResults("save_exp", "p1").length;
    expect(stageCount).toBeGreaterThan(0);

    // full 导出 → 全新库导入：明细保留
    const full = await source.service.exportSave("save_exp", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    const target = await setup("save_other", "other-seed");
    await target.service.importSave({ bytes: full.bytes });
    expect(target.policyDetails.listStageResults("save_exp", "p1")).toHaveLength(stageCount);
    expect(
      target.policyDetails.listReports("save_exp", "p1", { audience: "hidden" }).reports.length,
    ).toBeGreaterThan(0);

    // safe_share：偏差与结算明细/内档奏报全剥离；公开奏报保留
    const shared = await source.service.exportSave("save_exp", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const sharedTarget = await setup("save_shared_t", "shared-seed");
    await sharedTarget.service.importSave({ bytes: shared.bytes });
    expect(sharedTarget.policyDetails.listStageResults("save_exp", "p1")).toHaveLength(0);
    expect(sharedTarget.policyDetails.listDeviations("save_exp", "p1")).toHaveLength(0);
    expect(
      sharedTarget.policyDetails.listReports("save_exp", "p1", { audience: "hidden" }).reports,
    ).toHaveLength(0);
    expect(
      sharedTarget.policyDetails.listReports("save_exp", "p1", { audience: "public" }).reports
        .length,
    ).toBeGreaterThan(0);
    // hidden.policyTruth 随 state 剥离
    const sharedState = await sharedTarget.service.loadState("save_exp");
    expect(sharedState.hidden.policyTruth).toEqual({});
  });
});
