import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand, GameState } from "@mandate/domain";
import { FixedClock, planPolicyResume, type PolicyCommandAssets } from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "./helpers/character-fixtures";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function command(
  commandType: GameCommand["commandType"],
  baseRevision: number,
  payload: Record<string, unknown>,
): GameCommand {
  return {
    commandId: `cmd_${commandType}_${baseRevision}_${String(payload.characterId ?? payload.policyId)}`,
    commandType,
    saveId: "save_policy_resume",
    baseRevision,
    actor: { type: "player", id: "player" },
    payload,
    createdAt: FIXTURE_NOW,
  } as GameCommand;
}

async function setup(): Promise<SaveSystem> {
  const system = createSaveSystem({
    databasePath: ":memory:",
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(FIXTURE_NOW),
  });
  cleanup.push(() => system.close());
  await system.service.createSave({
    saveId: "save_policy_resume",
    scenarioId: "chongzhen-early",
    title: "resume responsibility",
    seed: "resume-responsibility",
  });
  await system.service.commitCommand(
    command("policy.propose", 0, {
      policyId: "policy-resume",
      templateId: "policy-zhenji-shaanxi",
      origin: { kind: "direct-decree" },
    }),
  );
  await system.service.commitCommand(command("policy.approve", 1, { policyId: "policy-resume" }));
  await system.service.commitCommand(
    command("policy.issue", 2, {
      policyId: "policy-resume",
      responsibleInstitutionId: "hu-bu",
      responsibleCharacterIds: ["huang-liji"],
    }),
  );
  return system;
}

async function suspendAfterDismissing(system: SaveSystem): Promise<void> {
  await system.service.commitCommand(
    command("character.assign-office", 3, {
      characterId: "huang-liji",
      officeId: null,
      reason: "免职",
    }),
  );
  await system.service.commitCommand(
    command("policy.suspend", 4, { policyId: "policy-resume", reason: "暂缓" }),
  );
}

async function blockDismissAndRefund(system: SaveSystem): Promise<GameState> {
  let state = await system.service.loadState("save_policy_resume");
  await system.service.commitCommand(
    command("country.adjust-resource", state.revision, {
      resource: "treasuryTaels",
      delta: -state.country.treasuryTaels,
      reason: "清空国库",
    }),
  );
  state = await system.service.loadState("save_policy_resume");
  await system.service.commitCommand(
    command("country.adjust-resource", state.revision, {
      resource: "grainReserveShi",
      delta: -state.country.grainReserveShi,
      reason: "清空粮储",
    }),
  );
  state = await system.service.loadState("save_policy_resume");
  await system.service.advanceTime("save_policy_resume", {
    commandId: "cmd_block_policy",
    baseRevision: state.revision,
    days: 1,
  });
  state = await system.service.loadState("save_policy_resume");
  expect(state.policies["policy-resume"]?.status).toBe("blocked");
  await system.service.commitCommand(
    command("character.assign-office", state.revision, {
      characterId: "huang-liji",
      officeId: null,
      reason: "免职",
    }),
  );
  state = await system.service.loadState("save_policy_resume");
  await system.service.commitCommand(
    command("country.adjust-resource", state.revision, {
      resource: "treasuryTaels",
      delta: 10_000,
      reason: "补充国库",
    }),
  );
  state = await system.service.loadState("save_policy_resume");
  await system.service.commitCommand(
    command("country.adjust-resource", state.revision, {
      resource: "grainReserveShi",
      delta: 10_000,
      reason: "补充粮储",
    }),
  );
  return system.service.loadState("save_policy_resume");
}

describe("review-policy-resume-responsibility", () => {
  it("rejects an invalid current assignee with zero persistence side effects, then resumes after reappointment", async () => {
    const system = await setup();
    await suspendAfterDismissing(system);
    const before = await system.service.loadState("save_policy_resume");
    const changesBefore = (await system.service.listChanges("save_policy_resume", {})).length;
    const transactionsBefore = Number(
      (
        system.database.prepare("SELECT COUNT(*) AS count FROM command_transactions").get() as {
          count: number;
        }
      ).count,
    );
    const reportsBefore = Number(
      (
        system.database.prepare("SELECT COUNT(*) AS count FROM policy_reports").get() as {
          count: number;
        }
      ).count,
    );
    const costsBefore = Number(
      (
        system.database.prepare("SELECT COUNT(*) AS count FROM policy_cost_applications").get() as {
          count: number;
        }
      ).count,
    );

    await expect(
      system.service.commitCommand(
        command("policy.resume", before.revision, { policyId: "policy-resume" }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_ASSIGNEE_INVALID" });

    const rejected = await system.service.loadState("save_policy_resume");
    expect(rejected.revision).toBe(before.revision);
    expect(rejected.policies["policy-resume"]?.status).toBe("suspended");
    expect(await system.service.listChanges("save_policy_resume", {})).toHaveLength(changesBefore);
    expect(
      Number(
        (
          system.database.prepare("SELECT COUNT(*) AS count FROM command_transactions").get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(transactionsBefore);
    expect(
      Number(
        (
          system.database.prepare("SELECT COUNT(*) AS count FROM policy_reports").get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(reportsBefore);
    expect(
      Number(
        (
          system.database
            .prepare("SELECT COUNT(*) AS count FROM policy_cost_applications")
            .get() as { count: number }
        ).count,
      ),
    ).toBe(costsBefore);
    expect(rejected.country).toEqual(before.country);

    await system.service.commitCommand(
      command("character.assign-office", rejected.revision, {
        characterId: "huang-liji",
        officeId: "nei-ge-shou-fu",
        reason: "复任",
      }),
    );
    const reappointed = await system.service.loadState("save_policy_resume");
    await expect(
      system.service.commitCommand(
        command("policy.resume", reappointed.revision, { policyId: "policy-resume" }),
      ),
    ).resolves.toMatchObject({ revision: reappointed.revision + 1 });
    expect(
      (await system.service.loadState("save_policy_resume")).policies["policy-resume"]?.status,
    ).toBe("issued");
  });

  it.each(["dismissed", "imprisoned", "exiled", "dead"] as const)(
    "rejects %s responsibility through the shared validator",
    async (status) => {
      const system = await setup();
      await system.service.commitCommand(
        command("policy.suspend", 3, { policyId: "policy-resume", reason: "暂缓" }),
      );
      const state = structuredClone(await system.service.loadState("save_policy_resume"));
      state.characters["huang-liji"]!.status = status;
      const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
      const assets: PolicyCommandAssets = {
        templates: structuredClone(bundle.policyTemplates) as PolicyCommandAssets["templates"],
        rules: [],
      };
      expect(() =>
        planPolicyResume(
          state as GameState,
          command("policy.resume", state.revision, { policyId: "policy-resume" }) as Extract<
            GameCommand,
            { commandType: "policy.resume" }
          >,
          assets,
        ),
      ).toThrowError(expect.objectContaining({ code: "POLICY_ASSIGNEE_INVALID" }));
    },
  );

  it("rejects blocked-to-implementing adjustment with an invalid existing assignee and no side effects", async () => {
    const system = await setup();
    const before = await blockDismissAndRefund(system);
    const changesBefore = await system.service.listChanges("save_policy_resume", {});
    const transactionsBefore = Number(
      (
        system.database.prepare("SELECT COUNT(*) AS count FROM command_transactions").get() as {
          count: number;
        }
      ).count,
    );

    await expect(
      system.service.commitCommand(
        command("policy.adjust", before.revision, {
          policyId: "policy-resume",
          additionalBudget: { treasuryTaels: 1_000 },
          reason: "追加预算触发恢复",
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_ASSIGNEE_INVALID" });

    expect(await system.service.loadState("save_policy_resume")).toEqual(before);
    expect(await system.service.listChanges("save_policy_resume", {})).toEqual(changesBefore);
    expect(
      Number(
        (
          system.database.prepare("SELECT COUNT(*) AS count FROM command_transactions").get() as {
            count: number;
          }
        ).count,
      ),
    ).toBe(transactionsBefore);
  });

  it("keeps a funded blocked policy inert when resolution sees an invalid assignee", async () => {
    const system = await setup();
    const before = await blockDismissAndRefund(system);
    const costsBefore = system.policyDetails.listCostApplications("save_policy_resume").length;
    const stagesBefore = system.policyDetails.listStageResults(
      "save_policy_resume",
      "policy-resume",
    );

    await system.service.advanceTime("save_policy_resume", {
      commandId: "cmd_invalid_assignee_resolution",
      baseRevision: before.revision,
      days: 1,
    });

    const after = await system.service.loadState("save_policy_resume");
    expect(after.policies["policy-resume"]).toEqual(before.policies["policy-resume"]);
    expect(after.country).toEqual(before.country);
    expect(system.policyDetails.listCostApplications("save_policy_resume")).toHaveLength(
      costsBefore,
    );
    expect(system.policyDetails.listStageResults("save_policy_resume", "policy-resume")).toEqual(
      stagesBefore,
    );
  });

  it("keeps an issued policy inert when its assignee becomes invalid before first resolution", async () => {
    const system = await setup();
    await system.service.commitCommand(
      command("character.assign-office", 3, {
        characterId: "huang-liji",
        officeId: null,
        reason: "颁行后免职",
      }),
    );
    const before = await system.service.loadState("save_policy_resume");
    const costsBefore = system.policyDetails.listCostApplications("save_policy_resume").length;
    const stagesBefore = system.policyDetails.listStageResults(
      "save_policy_resume",
      "policy-resume",
    );

    await system.service.advanceTime("save_policy_resume", {
      commandId: "cmd_invalid_issued_assignee_resolution",
      baseRevision: before.revision,
      days: 1,
    });

    const after = await system.service.loadState("save_policy_resume");
    expect(after.policies["policy-resume"]).toEqual(before.policies["policy-resume"]);
    expect(after.country).toEqual(before.country);
    expect(system.policyDetails.listCostApplications("save_policy_resume")).toHaveLength(
      costsBefore,
    );
    expect(system.policyDetails.listStageResults("save_policy_resume", "policy-resume")).toEqual(
      stagesBefore,
    );
  });

  it("allows an invalid suspended assignee to receive a non-resuming budget adjustment", async () => {
    const system = await setup();
    await suspendAfterDismissing(system);
    const before = await system.service.loadState("save_policy_resume");

    await expect(
      system.service.commitCommand(
        command("policy.adjust", before.revision, {
          policyId: "policy-resume",
          additionalBudget: { treasuryTaels: 100 },
          reason: "仅调整预算，不恢复执行",
        }),
      ),
    ).resolves.toMatchObject({ revision: before.revision + 1 });
    const after = await system.service.loadState("save_policy_resume");
    expect(after.policies["policy-resume"]?.status).toBe("suspended");
    expect(after.country.treasuryTaels).toBe(before.country.treasuryTaels - 100);
  });

  it("rejects institution, primary and secondary responsibility violations through one guard", async () => {
    const system = await setup();
    await system.service.commitCommand(
      command("policy.suspend", 3, { policyId: "policy-resume", reason: "集中校验" }),
    );
    const base = await system.service.loadState("save_policy_resume");
    const bundle = await createScenarioLoader().loadScenarioBundle("chongzhen-early");
    const assets: PolicyCommandAssets = {
      templates: structuredClone(bundle.policyTemplates) as PolicyCommandAssets["templates"],
      rules: [],
    };
    const variants = [
      (state: GameState) => {
        state.policies["policy-resume"]!.responsibleInstitutionId = "nei-ge";
      },
      (state: GameState) => {
        state.policies["policy-resume"]!.responsibleCharacterIds = ["wei-zhongxian"];
      },
      (state: GameState) => {
        state.policies["policy-resume"]!.responsibleCharacterIds = ["huang-liji", "wei-zhongxian"];
      },
    ];

    for (const mutate of variants) {
      const state = structuredClone(base) as GameState;
      mutate(state);
      expect(() =>
        planPolicyResume(
          state,
          command("policy.resume", state.revision, { policyId: "policy-resume" }) as Extract<
            GameCommand,
            { commandType: "policy.resume" }
          >,
          assets,
        ),
      ).toThrowError(expect.objectContaining({ code: "POLICY_ASSIGNEE_INVALID" }));
    }
  });
});
