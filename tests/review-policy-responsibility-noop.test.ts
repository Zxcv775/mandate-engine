import { createScenarioLoader } from "@mandate/data-loader";
import type { GameCommand } from "@mandate/domain";
import { FixedClock } from "@mandate/game-engine";
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
    commandId: `cmd_${commandType}_${baseRevision}`,
    commandType,
    saveId: "save_policy_noop",
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
    saveId: "save_policy_noop",
    scenarioId: "chongzhen-early",
    title: "responsibility noop",
    seed: "responsibility-noop",
  });
  await system.service.commitCommand(
    command("character.assign-office", 0, {
      characterId: "wei-zhongxian",
      officeId: "hu-bu-shang-shu",
      reason: "协办户部",
    }),
  );
  await system.service.commitCommand(
    command("character.assign-office", 1, {
      characterId: "wang-cheng-en",
      officeId: "liao-dong-xun-fu",
      reason: "督办辽饷",
    }),
  );
  await system.service.commitCommand(
    command("policy.propose", 2, {
      policyId: "policy-noop",
      templateId: "policy-neitang-liaoxiang",
      origin: { kind: "direct-decree" },
    }),
  );
  await system.service.commitCommand(command("policy.approve", 3, { policyId: "policy-noop" }));
  await system.service.commitCommand(
    command("policy.issue", 4, {
      policyId: "policy-noop",
      responsibleInstitutionId: "hu-bu",
      responsibleCharacterIds: ["huang-liji", "wei-zhongxian", "wang-cheng-en"],
    }),
  );
  return system;
}

describe("review-policy-responsibility-noop", () => {
  it("treats only secondary reordering as no-op and preserves a real primary change", async () => {
    const system = await setup();
    const before = await system.service.loadState("save_policy_noop");
    const changesBefore = (await system.service.listChanges("save_policy_noop", {})).length;
    const updatedAtBefore = before.meta.updatedAt;

    await expect(
      system.service.commitCommand(
        command("policy.adjust", before.revision, {
          policyId: "policy-noop",
          responsibleCharacterIds: ["huang-liji", "wang-cheng-en", "wei-zhongxian"],
          reason: "仅调整协办展示顺序",
        }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_NO_CHANGES" });

    const afterNoop = await system.service.loadState("save_policy_noop");
    expect(afterNoop.revision).toBe(before.revision);
    expect(afterNoop.meta.updatedAt).toBe(updatedAtBefore);
    expect(afterNoop.policies["policy-noop"]?.responsibleCharacterIds).toEqual([
      "huang-liji",
      "wei-zhongxian",
      "wang-cheng-en",
    ]);
    expect(await system.service.listChanges("save_policy_noop", {})).toHaveLength(changesBefore);

    await expect(
      system.service.commitCommand(
        command("policy.adjust", afterNoop.revision, {
          policyId: "policy-noop",
          responsibleCharacterIds: ["wei-zhongxian", "huang-liji", "wang-cheng-en"],
          reason: "改任第一负责人",
        }),
      ),
    ).resolves.toMatchObject({ revision: afterNoop.revision + 1 });
    expect(
      (await system.service.loadState("save_policy_noop")).policies["policy-noop"]
        ?.responsibleCharacterIds,
    ).toEqual(["wei-zhongxian", "huang-liji", "wang-cheng-en"]);
  });

  it("still rejects duplicate and empty responsibility lists", async () => {
    const system = await setup();
    const revision = (await system.service.loadState("save_policy_noop")).revision;
    for (const responsibleCharacterIds of [[], ["huang-liji", "huang-liji"]]) {
      await expect(
        system.service.commitCommand(
          command("policy.adjust", revision, {
            policyId: "policy-noop",
            responsibleCharacterIds,
            reason: "非法负责人列表",
          }),
        ),
      ).rejects.toMatchObject({ code: expect.any(String) });
    }
    expect((await system.service.loadState("save_policy_noop")).revision).toBe(revision);
  });
});
