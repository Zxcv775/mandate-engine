import { writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioLoader } from "@mandate/data-loader";
import { FixedClock } from "@mandate/game-engine";
import { createSaveSystem } from "@mandate/save-system";
import {
  planNextStep,
  scheduleNextSpeaker,
  evaluateSpeakerEligibility,
} from "@mandate/meeting-engine";
import type {
  MeetingParticipantState,
  MeetingSessionState,
  MeetingTurnRecord,
} from "@mandate/domain";
import { createCharacterMockProvider } from "@mandate/agent-runtime";
import { buildApp } from "../apps/server/src/app";
import { parseRuntimeConfig } from "../apps/server/src/config/index";

/** Phase 4 性能基准（§22）：Director/Scheduler/Transcript/恢复/完整 Mock 会议。 */

const NOW = "2026-07-26T00:00:00.000Z";
const NAMES = {
  "wei-zhongxian": "魏忠贤",
  "huang-liji": "黄立极",
  "cui-chengxiu": "崔呈秀",
  "wang-cheng-en": "王承恩",
};

function measure(label: string, iterations: number, fn: () => void) {
  fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) fn();
  return { label, avgMs: Number(((performance.now() - started) / iterations).toFixed(3)) };
}

function makeParticipants(count: number): MeetingParticipantState[] {
  return Array.from({ length: count }, (_, index) => ({
    meetingId: "bench",
    characterId: `char-${String(index).padStart(2, "0")}`,
    role: "minister" as const,
    attendance: "present" as const,
    speakingRights: "normal" as const,
    turnsSpoken: index % 5,
    requestedToSpeak: index % 3 === 0,
    challengedCharacterIds: [],
    runtimeFlags: [],
  }));
}

function benchSession(participants: MeetingParticipantState[]): MeetingSessionState {
  return {
    meetingId: "bench",
    saveId: "save_bench",
    type: "imperial-council",
    status: "in-progress",
    title: "基准会议",
    purpose: "测速",
    createdAtRevision: 0,
    meetingVersion: 1,
    turnNumber: 10,
    participantIds: participants.map((p) => p.characterId),
    chairCharacterId: "emperor",
    agendaItemIds: ["ag"],
    currentAgendaItemId: "ag",
    limits: {
      maxTurns: 200,
      maxTurnsPerAgenda: 100,
      maxConsecutiveTurnsPerCharacter: 3,
      maxTurnsPerCharacter: 50,
      maxConsecutiveAgentTurns: 50,
      maxConsecutiveRebuttals: 10,
    },
    usedTurns: 10,
    visibility: "meeting",
    outcomeCandidateIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const benchAgenda = {
  agendaItemId: "ag",
  meetingId: "bench",
  title: "基准议程",
  description: "测速",
  topicIds: ["bench"],
  proposerId: "emperor",
  status: "discussing" as const,
  priority: 50,
  sequence: 0,
  maxTurns: 100,
  usedTurns: 10,
  relatedEntityIds: [],
  requiredOfficeIds: [],
  visibility: "meeting" as const,
};

async function main(): Promise<void> {
  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    node: process.version,
  };

  // Scheduler / Eligibility / Director：5 / 10 / 20 人
  for (const count of [5, 10, 20]) {
    const participants = makeParticipants(count);
    const session = benchSession(participants);
    const candidates = participants.map((participant) => ({
      eligibility: {
        characterId: participant.characterId,
        runtime: {
          characterId: participant.characterId,
          status: "active" as const,
          officeId: null,
          favor: 0,
          loyaltyToEmperor: 50,
          stress: 0,
          lastUpdatedRevision: 0,
          sourceIds: [],
        },
        participant,
        session,
        agendaItem: benchAgenda,
        topicAccess: "normal" as const,
        emperorSelected: false,
      },
    }));
    results[`eligibility${count}`] = measure(`eligibility-${count}`, 200, () => {
      for (const candidate of candidates) evaluateSpeakerEligibility(candidate.eligibility);
    });
    results[`scheduler${count}`] = measure(`scheduler-${count}`, 200, () => {
      scheduleNextSpeaker(session, benchAgenda, candidates);
    });
    results[`director${count}`] = measure(`director-${count}`, 200, () => {
      planNextStep({ session, agenda: [benchAgenda], recentTurns: [], candidates });
    });
  }

  // Transcript：100 / 1000 回合写入与查询、恢复加载、体积
  const directory = await mkdtemp(join(tmpdir(), "mandate-p4-bench-"));
  try {
    const databasePath = join(directory, "bench.sqlite");
    const system = createSaveSystem({
      databasePath,
      scenarioLoader: createScenarioLoader(),
      clock: new FixedClock(NOW),
    });
    await system.service.createSave({
      saveId: "save_bench",
      scenarioId: "chongzhen-early",
      title: "基准",
      seed: "bench",
    });
    const participants = makeParticipants(5);
    system.meetings.createSession(benchSession(participants), participants, [benchAgenda]);

    const sizeBefore = (await stat(databasePath)).size;
    const writeStart = performance.now();
    for (let index = 0; index < 1_000; index++) {
      const turn: MeetingTurnRecord = {
        turnId: `turn-${String(index).padStart(4, "0")}`,
        meetingId: "bench",
        saveId: "save_bench",
        agendaItemId: "ag",
        turnNumber: index,
        type: "character-speech",
        speakerId: participants[index % participants.length]!.characterId,
        addressedCharacterIds: ["emperor"],
        publicText: `第 ${index} 番奏对：兹事体大，容臣详陈本末，以备圣裁参酌。`,
        visibility: "meeting",
        stateRevision: 1,
        meetingVersion: index + 2,
        sourceTurnIds: [],
        createdAt: NOW,
      };
      system.meetings.appendTurn(turn);
    }
    results.transcriptWrite1000 = {
      totalMs: Number((performance.now() - writeStart).toFixed(1)),
    };
    system.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const sizeAfter = (await stat(databasePath)).size;
    results.transcriptStorage = {
      rows: 1_000,
      bytes: sizeAfter - sizeBefore,
      bytesPerTurn: Number(((sizeAfter - sizeBefore) / 1_000).toFixed(1)),
    };

    results.transcriptPage100 = measure("transcript-page", 100, () => {
      system.meetings.listTurns("bench", { limit: 100 });
    });
    results.transcriptFilter = measure("transcript-filter-speaker", 100, () => {
      system.meetings.listTurns("bench", { speakerId: "char-01", limit: 100 });
    });
    results.meetingRecoveryLoad = measure("meeting-recovery-load", 100, () => {
      system.meetings.getSession("bench");
      system.meetings.listParticipants("bench");
      system.meetings.listAgendaItems("bench");
      system.meetings.listTurns("bench", { limit: 12 });
    });

    // 50 个结果候选查询
    for (let index = 0; index < 50; index++) {
      system.meetings.insertOutcomeCandidate({
        outcomeCandidateId: `oc-${String(index).padStart(2, "0")}`,
        meetingId: "bench",
        saveId: "save_bench",
        agendaItemId: "ag",
        type: "policy-proposal",
        title: `建议第 ${index} 号`,
        summary: "以备圣裁",
        proposerIds: ["char-00"],
        supporterIds: [],
        opponentIds: [],
        rationale: ["理由"],
        risks: [],
        sourceTurnIds: ["turn-0000"],
        status: index % 2 === 0 ? "presented" : "rejected",
        unsupportedCommand: true,
        createdAtRevision: 1,
        createdAt: NOW,
      });
    }
    results.outcomeQuery50 = measure("outcome-query-50", 200, () => {
      system.meetings.listOutcomeCandidates("bench");
    });
    system.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // 5 人 20 回合完整 Mock 会议流程（API 级）
  const app = await buildApp({
    config: parseRuntimeConfig({ NODE_ENV: "test", LLM_PROVIDER: "mock" }),
    provider: createCharacterMockProvider({ defaultStance: "support" }, NAMES),
    logger: false,
  });
  await app.inject({
    method: "POST",
    url: "/api/saves",
    payload: { saveId: "sb", scenarioId: "chongzhen-early", title: "b", seed: "b" },
  });
  await app.inject({
    method: "POST",
    url: "/api/saves/sb/meetings",
    payload: {
      meetingId: "mb",
      type: "imperial-council",
      title: "基准会议",
      purpose: "测速",
      participantIds: Object.keys(NAMES),
      expectedRevision: 0,
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/saves/sb/meetings/mb/agenda",
    payload: { agendaItemId: "agb", title: "议题", description: "描述", maxTurns: 100 },
  });
  await app.inject({
    method: "POST",
    url: "/api/saves/sb/meetings/mb/start",
    payload: { expectedRevision: 1, expectedMeetingVersion: 2 },
  });
  const J = (r: { body: string }) => JSON.parse(r.body) as { data: ReturnType<typeof JSON.parse> };
  const meetingStart = performance.now();
  let turns = 0;
  let session = J(await app.inject({ method: "GET", url: "/api/saves/sb/meetings/mb" })).data
    .session;
  while (turns < 20) {
    const result = await app.inject({
      method: "POST",
      url: "/api/saves/sb/meetings/mb/step",
      payload: { expectedRevision: 2, expectedMeetingVersion: session.meetingVersion },
    });
    if (result.statusCode !== 200) break;
    const data = J(result).data;
    session = data.session;
    if (data.newTurn) turns++;
    if (session.status === "waiting-for-player") {
      const act = await app.inject({
        method: "POST",
        url: "/api/saves/sb/meetings/mb/actions",
        payload: {
          expectedRevision: 2,
          expectedMeetingVersion: session.meetingVersion,
          action: { type: "address-meeting", text: "众卿继续奏对。" },
        },
      });
      session = J(act).data.session;
      turns++;
    }
  }
  results.fullMockMeeting = {
    turns,
    totalMs: Number((performance.now() - meetingStart).toFixed(1)),
    avgMsPerTurn: Number(((performance.now() - meetingStart) / Math.max(turns, 1)).toFixed(1)),
  };
  await app.close();

  const outputPath = fileURLToPath(
    new URL("../docs/progress/phase4-benchmark.json", import.meta.url),
  );
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(results, null, 2));
  console.log("基准结果已写入 docs/progress/phase4-benchmark.json");
}

await main();
