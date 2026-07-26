import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameCommand, ModifierState, Rule } from "@mandate/domain";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { evaluateRules, resolveEffectiveValue } from "@mandate/rule-engine";
import { createSaveSystem } from "@mandate/save-system";
import { makeFixtureState } from "../tests/helpers/character-fixtures";

/** Phase 5 性能基准（§十四）：单政策结算 / 多政策长程推进 / 规则求值 / Modifier 合成 / 明细分页。 */

const NOW = "2026-07-27T00:00:00.000Z";

function measure(label: string, iterations: number, fn: () => void) {
  fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) fn();
  return { label, avgMs: Number(((performance.now() - started) / iterations).toFixed(4)) };
}

function makeRules(count: number): Rule[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bench-rule-${String(index).padStart(3, "0")}`,
    version: 1,
    scope: "policy-resolution" as const,
    description: "基准规则",
    priority: index % 100,
    condition: {
      op: "and" as const,
      conditions: [
        { op: "gte" as const, path: "country.stability", value: index % 100 },
        { op: "lt" as const, path: "country.legitimacy", value: 100 },
      ],
    },
    effects: [
      {
        type: "adjust-country-metric" as const,
        metric: "stability" as const,
        amount: 1,
        reason: "基准",
      },
    ],
    sourceIds: [],
  }));
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    node: process.version,
  };

  // 规则求值：100 / 500 条
  const state = makeFixtureState();
  for (const count of [100, 500]) {
    const rules = makeRules(count);
    results[`ruleEvaluation${count}`] = measure(`rules-${count}`, 50, () => {
      evaluateRules({
        rules,
        scope: "policy-resolution",
        context: {
          tick: 10,
          country: state.country,
          regions: state.regions,
          flags: state.flags,
        },
      });
    });
  }

  // Modifier 500 条时 resolveEffectiveValue
  const modifiers: Record<string, ModifierState> = {};
  for (let index = 0; index < 500; index++) {
    const id = `bench-mod-${String(index).padStart(3, "0")}`;
    modifiers[id] = {
      modifierId: id,
      target: { kind: "country" },
      metric: index % 2 === 0 ? "stability" : "legitimacy",
      operation: index % 3 === 0 ? "mul" : "add",
      value: index % 3 === 0 ? 1.001 : 1,
      source: { kind: "system", label: "bench" },
      effectiveTick: 0,
      expiresAtTick: null,
      stacking: "stack",
      reason: "基准",
      sourceIds: [],
    };
  }
  const modifierState = { ...state, modifiers };
  results.effectiveValue500 = measure("effective-value-500", 200, () => {
    resolveEffectiveValue(modifierState, { kind: "country" }, "stability", 10);
  });

  // 端到端：单政策单 tick 结算耗时 + 20 政策 × 120 tick
  const directory = await mkdtemp(join(tmpdir(), "mandate-p5-bench-"));
  try {
    const system = createSaveSystem({
      databasePath: join(directory, "bench.sqlite"),
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(NOW),
    });
    await system.service.createSave({
      saveId: "save_bench",
      scenarioId: "chongzhen-early",
      title: "基准",
      seed: "bench-p5",
    });
    const command = (
      commandType: GameCommand["commandType"],
      baseRevision: number,
      payload: Record<string, unknown>,
    ): GameCommand =>
      ({
        commandId: `cmd_${commandType}_${baseRevision}`,
        commandType,
        saveId: "save_bench",
        baseRevision,
        actor: { type: "player", id: "player" },
        payload,
        createdAt: NOW,
      }) as GameCommand;

    // 注入充足国库并铺开 20 个政策
    let revision = 0;
    await system.service.commitCommand(
      command("country.adjust-resource", revision, {
        resource: "treasuryTaels",
        delta: 50_000_000,
        reason: "基准注资",
      }),
    );
    revision += 1;
    await system.service.commitCommand(
      command("country.adjust-resource", revision, {
        resource: "grainReserveShi",
        delta: 20_000_000,
        reason: "基准注粮",
      }),
    );
    revision += 1;
    const templates = [
      "policy-zhenji-shaanxi",
      "policy-qinding-nian",
      "policy-chaihui-shengci",
      "policy-neitang-liaoxiang",
      "policy-qingcha-jingying",
      "policy-hecha-maoxiang",
      "policy-juanmian-bufu",
      "policy-yidi-zhengdun",
      "policy-qifu-zhuchen",
      "policy-zhenji-shaanxi",
      "policy-qinding-nian",
      "policy-chaihui-shengci",
      "policy-neitang-liaoxiang",
      "policy-qingcha-jingying",
      "policy-hecha-maoxiang",
      "policy-juanmian-bufu",
      "policy-yidi-zhengdun",
      "policy-qifu-zhuchen",
      "policy-zhenji-shaanxi",
      "policy-qinding-nian",
    ];
    for (let index = 0; index < templates.length; index++) {
      const policyId = `bench-p${String(index).padStart(2, "0")}`;
      await system.service.commitCommand(
        command("policy.propose", revision, {
          policyId,
          templateId: templates[index],
          origin: { kind: "direct-decree" },
        }),
      );
      revision += 1;
      await system.service.commitCommand(command("policy.approve", revision, { policyId }));
      revision += 1;
      await system.service.commitCommand(
        command("policy.issue", revision, {
          policyId,
          responsibleInstitutionId:
            templates[index] === "policy-zhenji-shaanxi" ||
            templates[index] === "policy-neitang-liaoxiang" ||
            templates[index] === "policy-juanmian-bufu"
              ? "hu-bu"
              : templates[index] === "policy-qinding-nian" ||
                  templates[index] === "policy-chaihui-shengci" ||
                  templates[index] === "policy-qifu-zhuchen"
                ? "nei-ge"
                : "bing-bu",
          responsibleCharacterIds: ["huang-liji", "cui-chengxiu"],
          additionalBudget: { treasuryTaels: 500_000, grainReserveShi: 50_000 },
        }),
      );
      revision += 1;
    }

    // 单政策单 tick（20 政策同帧 → 单政策均摊）
    const singleStart = performance.now();
    await system.service.advanceTime("save_bench", {
      commandId: "cmd_bench_tick_single",
      baseRevision: revision,
      days: 1,
    });
    revision += 1;
    const singleMs = performance.now() - singleStart;
    results.singleTick20Policies = {
      totalMs: Number(singleMs.toFixed(2)),
      perPolicyMs: Number((singleMs / 20).toFixed(3)),
    };

    // 120 tick 连续推进（逐日）
    const longStart = performance.now();
    for (let day = 0; day < 119; day++) {
      await system.service.advanceTime("save_bench", {
        commandId: `cmd_bench_tick_${day}`,
        baseRevision: revision,
        days: 1,
      });
      revision += 1;
    }
    results.longRun20x120 = {
      totalMs: Number((performance.now() - longStart).toFixed(1)),
      avgTickMs: Number(((performance.now() - longStart) / 119).toFixed(2)),
    };
    const logs = system.database
      .prepare("SELECT COUNT(*) AS count FROM state_change_log WHERE save_id = ?")
      .get("save_bench") as { count: number };
    results.stateChangeLogRows = Number(logs.count);

    // 千条明细分页
    results.reportPagination = measure("report-page", 100, () => {
      system.policyDetails.listReports("save_bench", "bench-p00", { limit: 50 });
    });
    results.stageResultQuery = measure("stage-results", 100, () => {
      system.policyDetails.listStageResults("save_bench", "bench-p00", 100);
    });
    const reportRows = system.database
      .prepare("SELECT COUNT(*) AS count FROM policy_reports")
      .get() as { count: number };
    results.reportRows = Number(reportRows.count);
    system.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    system.close();
  } finally {
    // Windows 下 WAL 句柄释放存在竞态：清理为尽力而为，不影响基准结果
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      console.warn(`临时目录未能清理（可忽略）：${directory}`);
    }
  }

  const outputPath = fileURLToPath(
    new URL("../docs/progress/phase5-benchmark.json", import.meta.url),
  );
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
  console.log("基准结果已写入 docs/progress/phase5-benchmark.json");
}

await main();
