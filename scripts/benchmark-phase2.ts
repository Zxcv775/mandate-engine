import { createScenarioLoader } from "@mandate/data-loader";
import {
  FixedClock,
  StateEngine,
  type TimeAdvanceHook,
} from "@mandate/game-engine";
import { createSaveSystem, type SaveSystem } from "@mandate/save-system";
import { cpus, platform, release, totalmem } from "node:os";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NOW = "2026-07-26T00:00:00.000Z";

export interface BenchmarkOptions {
  maxRevision?: number;
  logTarget?: number;
  repeats?: number;
}

export interface TimingSummary {
  average: number;
  minimum: number;
  maximum: number;
  runs: number;
}

export interface Phase2BenchmarkResult {
  generatedAt: string;
  environment: {
    platform: string;
    release: string;
    architecture: string;
    cpu: string;
    logicalCpuCount: number;
    memoryGiB: number;
    node: string;
  };
  fixture: {
    scenarioId: string;
    maxRevision: number;
    logTarget: number;
    actualLogCount: number;
    repeats: number;
    checkpointIntervals: readonly [50, 100];
  };
  transactionMutationCounts: {
    singleDomainMutation: number;
    tenMutationTransaction: number;
  };
  timingsMs: Record<string, TimingSummary>;
  sizes: {
    averageLogPayloadBytes: number;
    tenThousandLogDatabaseBytes: number;
    snapshotInterval50Bytes: number;
    snapshotInterval100Bytes: number;
    exportWithSourcesBytes: number;
    exportWithoutSourcesBytes: number;
    observedWalBytes: number;
  };
  anomalies: string[];
  assumptions: string[];
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

async function measure(runs: number, action: () => Promise<void> | void): Promise<TimingSummary> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await action();
    samples.push(performance.now() - started);
  }
  return {
    average: rounded(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    minimum: rounded(Math.min(...samples)),
    maximum: rounded(Math.max(...samples)),
    runs,
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function advanceTo(system: SaveSystem, saveId: string, targetRevision: number): Promise<void> {
  let revision = (await system.service.getSave(saveId)).headRevision;
  while (revision < targetRevision) {
    await system.service.advanceTime(saveId, {
      commandId: `cmd_advance_${revision + 1}`,
      baseRevision: revision,
      days: 1,
    });
    revision += 1;
  }
}

async function createFixture(
  directory: string,
  name: string,
  checkpointInterval: number,
  stateEngine?: StateEngine,
): Promise<SaveSystem> {
  return createSaveSystem({
    databasePath: join(directory, `${name}.sqlite`),
    scenarioLoader: createScenarioLoader(),
    clock: new FixedClock(NOW),
    checkpointInterval,
    ...(stateEngine ? { stateEngine } : {}),
  });
}

function tenMutationHook(): TimeAdvanceHook {
  return {
    onBeforeAdvance({ state, random }) {
      random.nextFloat();
      const resources = [
        "treasuryTaels",
        "grainReserveShi",
        "legitimacy",
        "stability",
        "administrativeCapacity",
        "militaryReadiness",
      ] as const;
      return resources.map((resource) => ({
        aggregateType: "country",
        operation: "increment" as const,
        path: `/country/${resource}`,
        before: state.country[resource],
        after: state.country[resource] + 1,
        sourceIds: state.country.sourceIds,
        visibility: "internal" as const,
        tags: ["benchmark"],
      }));
    },
  };
}

function collectAnomalies(timings: Record<string, TimingSummary>): string[] {
  return Object.entries(timings)
    .filter(([, value]) => value.runs > 1 && value.minimum > 0 && value.maximum / value.minimum >= 3)
    .map(
      ([name, value]) =>
        `${name} 最大值 ${value.maximum}ms 是最小值 ${value.minimum}ms 的至少 3 倍`,
    );
}

export async function runPhase2Benchmark(
  input: BenchmarkOptions = {},
): Promise<Phase2BenchmarkResult> {
  const maxRevision = input.maxRevision ?? 1_000;
  const logTarget = input.logTarget ?? 10_000;
  const repeats = input.repeats ?? 5;
  if (!Number.isInteger(maxRevision) || maxRevision < 10) throw new Error("maxRevision 至少为 10");
  if (!Number.isInteger(logTarget) || logTarget < 10) throw new Error("logTarget 至少为 10");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats 至少为 1");

  const directory = await mkdtemp(join(tmpdir(), "mandate-phase2-benchmark-"));
  const systems: SaveSystem[] = [];
  const timingsMs: Record<string, TimingSummary> = {};
  try {
    const mainPath = join(directory, "snapshot-50.sqlite");
    const main = await createFixture(directory, "snapshot-50", 50);
    systems.push(main);
    timingsMs.createSave = await measure(1, async () => {
      await main.service.createSave({
        saveId: "save_main",
        scenarioId: "chongzhen-early",
        title: "Phase 2 benchmark",
        seed: "benchmark-seed",
      });
    });
    timingsMs.loadRevision0 = await measure(repeats, async () => {
      await main.service.loadState("save_main");
    });

    let singleMutationCount = 0;
    timingsMs.commitSingleMutation = await measure(repeats, async () => {
      const revision = (await main.service.getSave("save_main")).headRevision;
      const result = await main.service.commitCommand({
        commandId: `cmd_single_${revision + 1}`,
        commandType: "country.adjust-resource",
        saveId: "save_main",
        baseRevision: revision,
        actor: { type: "system", id: "benchmark" },
        payload: {
          resource: "treasuryTaels",
          delta: revision % 2 === 0 ? 1 : -1,
          reason: "benchmark single domain mutation",
        },
        createdAt: NOW,
      });
      singleMutationCount = result.mutationCount;
    });
    await advanceTo(main, "save_main", maxRevision - 1);
    timingsMs.createCheckpoint = await measure(1, async () => {
      await main.service.createCheckpoint("save_main", {
        kind: "manual",
        label: "benchmark-head-minus-one",
      });
    });
    await advanceTo(main, "save_main", maxRevision);
    const revision100 = Math.min(100, maxRevision);
    timingsMs.loadRevision100 = await measure(repeats, async () => {
      main.repository.loadStateAtRevision("save_main", revision100);
    });
    timingsMs.loadRevision1000 = await measure(repeats, async () => {
      main.repository.loadStateAtRevision("save_main", maxRevision);
    });

    const replay = await createFixture(directory, "replay", maxRevision + 1);
    systems.push(replay);
    await replay.service.createSave({
      saveId: "save_replay",
      scenarioId: "chongzhen-early",
      title: "Replay benchmark",
      seed: "replay-seed",
    });
    const replayTarget = Math.min(100, maxRevision);
    await advanceTo(replay, "save_replay", replayTarget);
    timingsMs.replay50 = await measure(repeats, async () => {
      replay.repository.loadStateAtRevision("save_replay", Math.min(50, replayTarget));
    });
    timingsMs.replay100 = await measure(repeats, async () => {
      replay.repository.loadStateAtRevision("save_replay", replayTarget);
    });

    const tenEngine = new StateEngine({
      clock: new FixedClock(NOW),
      timeAdvanceHooks: [tenMutationHook()],
    });
    const ten = await createFixture(directory, "ten-mutations", 100, tenEngine);
    systems.push(ten);
    await ten.service.createSave({
      saveId: "save_ten",
      scenarioId: "chongzhen-early",
      title: "Ten mutation benchmark",
      seed: "ten-seed",
    });
    let tenMutationCount = 0;
    timingsMs.commitTenMutations = await measure(repeats, async () => {
      const revision = (await ten.service.getSave("save_ten")).headRevision;
      const result = await ten.service.advanceTime("save_ten", {
        commandId: `cmd_ten_${revision + 1}`,
        baseRevision: revision,
        days: 1,
      });
      tenMutationCount = result.mutationCount;
    });

    let exportWithSources = await main.service.exportSave("save_main", {
      includeSourceMetadata: true,
      safeShareMode: "none",
    });
    timingsMs.exportSave = await measure(repeats, async () => {
      exportWithSources = await main.service.exportSave("save_main", {
        includeSourceMetadata: true,
        safeShareMode: "none",
      });
    });
    const exportWithoutSources = await main.service.exportSave("save_main", {
      includeSourceMetadata: false,
      safeShareMode: "safe_share",
    });
    const imported = await createFixture(directory, "import-target", 50);
    systems.push(imported);
    timingsMs.importSave = await measure(1, async () => {
      await imported.service.importSave({ bytes: exportWithSources.bytes });
    });
    timingsMs.validateSave = await measure(repeats, async () => {
      await main.service.validateSave("save_main");
    });

    const observedWalBytes = await fileSize(`${mainPath}-wal`);
    main.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const snapshotInterval50Bytes = await fileSize(mainPath);

    const interval100Path = join(directory, "snapshot-100.sqlite");
    const interval100 = await createFixture(directory, "snapshot-100", 100);
    systems.push(interval100);
    await interval100.service.createSave({
      saveId: "save_interval_100",
      scenarioId: "chongzhen-early",
      title: "Snapshot interval 100",
      seed: "interval-100-seed",
    });
    await advanceTo(interval100, "save_interval_100", maxRevision);
    interval100.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const snapshotInterval100Bytes = await fileSize(interval100Path);

    const volumePath = join(directory, "log-volume.sqlite");
    const volume = await createFixture(directory, "log-volume", 100);
    systems.push(volume);
    await volume.service.createSave({
      saveId: "save_volume",
      scenarioId: "chongzhen-early",
      title: "Log volume",
      seed: "volume-seed",
    });
    let actualLogCount = 0;
    let volumeRevision = 0;
    while (actualLogCount < logTarget) {
      await volume.service.commitCommand({
        commandId: `cmd_volume_${volumeRevision + 1}`,
        commandType: "country.adjust-resource",
        saveId: "save_volume",
        baseRevision: volumeRevision,
        actor: { type: "system", id: "benchmark" },
        payload: {
          resource: "treasuryTaels",
          delta: volumeRevision % 2 === 0 ? 1 : -1,
          reason: "log volume benchmark",
        },
        createdAt: NOW,
      });
      volumeRevision += 1;
      actualLogCount = volume.repository.countRows().logs;
    }
    const averageLog = volume.database
      .prepare(
        `SELECT AVG(
           length(CAST(command_type AS BLOB)) + length(CAST(command_id AS BLOB)) +
           length(CAST(aggregate_type AS BLOB)) + length(CAST(path AS BLOB)) +
           length(CAST(diff_json AS BLOB)) + length(CAST(inverse_diff_json AS BLOB)) +
           length(CAST(source_ids_json AS BLOB)) + length(CAST(tags_json AS BLOB)) +
           length(CAST(entry_hash AS BLOB))
         ) AS average_bytes FROM state_change_log WHERE save_id = ?`,
      )
      .get("save_volume") as { average_bytes: number };
    volume.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const logVolumeDatabaseBytes = await fileSize(volumePath);

    const result: Phase2BenchmarkResult = {
      generatedAt: new Date().toISOString(),
      environment: {
        platform: platform(),
        release: release(),
        architecture: process.arch,
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        memoryGiB: rounded(totalmem() / 1024 ** 3),
        node: process.version,
      },
      fixture: {
        scenarioId: "chongzhen-early",
        maxRevision,
        logTarget,
        actualLogCount,
        repeats,
        checkpointIntervals: [50, 100],
      },
      transactionMutationCounts: {
        singleDomainMutation: singleMutationCount,
        tenMutationTransaction: tenMutationCount,
      },
      timingsMs,
      sizes: {
        averageLogPayloadBytes: rounded(Number(averageLog.average_bytes)),
        tenThousandLogDatabaseBytes: logVolumeDatabaseBytes,
        snapshotInterval50Bytes,
        snapshotInterval100Bytes,
        exportWithSourcesBytes: exportWithSources.bytes.byteLength,
        exportWithoutSourcesBytes: exportWithoutSources.bytes.byteLength,
        observedWalBytes,
      },
      anomalies: collectAnomalies(timingsMs),
      assumptions: [
        `loadRevision1000 使用本次 fixture 的最大 revision ${maxRevision}`,
        `replay50/replay100 分别代表从初始 snapshot 重放至最多 50/100 个 revision`,
        `tenThousandLogDatabaseBytes 对应本次实际 ${actualLogCount} 条日志；正式基准目标为 10000`,
        "平均日志大小是固定列与 JSON/BLOB 负载之和，不含 SQLite B-tree 页开销",
        "WAL 数值是工作负载结束时观测值，不是持续采样的绝对峰值",
      ],
    };
    result.anomalies = collectAnomalies(result.timingsMs);
    if (snapshotInterval100Bytes >= snapshotInterval50Bytes) {
      result.anomalies.push(
        "本次 snapshot/100 文件未小于 snapshot/50；SQLite 页分配与工作负载差异使文件大小不具单调性",
      );
    }
    return result;
  } finally {
    for (const system of systems.reverse()) {
      try {
        system.close();
      } catch {
        // 已关闭连接无需再次处理。
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function markdown(result: Phase2BenchmarkResult): string {
  const timingRows = Object.entries(result.timingsMs)
    .map(
      ([name, value]) =>
        `| ${name} | ${value.runs} | ${value.average} | ${value.minimum} | ${value.maximum} |`,
    )
    .join("\n");
  return `# Phase 2 性能基准\n\n` +
    `- 生成时间：${result.generatedAt}\n` +
    `- 环境：${result.environment.platform} ${result.environment.release} / ${result.environment.cpu} / Node ${result.environment.node}\n` +
    `- Fixture：revision ${result.fixture.maxRevision}，日志 ${result.fixture.actualLogCount}，重复 ${result.fixture.repeats} 次\n\n` +
    `## 耗时（ms）\n\n| 操作 | 次数 | 平均 | 最小 | 最大 |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n` +
    `## 体积（bytes）\n\n` +
    `- 单条日志平均负载：${result.sizes.averageLogPayloadBytes}\n` +
    `- ${result.fixture.actualLogCount} 条日志数据库：${result.sizes.tenThousandLogDatabaseBytes}\n` +
    `- snapshot/50：${result.sizes.snapshotInterval50Bytes}\n` +
    `- snapshot/100：${result.sizes.snapshotInterval100Bytes}\n` +
    `- 导出（含来源目录）：${result.sizes.exportWithSourcesBytes}\n` +
    `- 导出（剥离来源目录）：${result.sizes.exportWithoutSourcesBytes}\n` +
    `- WAL 观测值：${result.sizes.observedWalBytes}\n\n` +
    `## 异常值\n\n${result.anomalies.length ? result.anomalies.map((value) => `- ${value}`).join("\n") : "- 未检测到最大/最小比达到 3 倍的样本"}\n\n` +
    `## 估算前提\n\n${result.assumptions.map((value) => `- ${value}`).join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const quick = process.argv.includes("--quick");
  const result = await runPhase2Benchmark(
    quick ? { maxRevision: 20, logTarget: 100, repeats: 1 } : {},
  );
  await mkdir("docs/progress", { recursive: true });
  await writeFile("docs/progress/phase2-benchmark.json", `${JSON.stringify(result, null, 2)}\n`);
  await writeFile("docs/progress/2026-07-26-phase2-benchmark.md", markdown(result));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
