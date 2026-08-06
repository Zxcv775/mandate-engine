import type {
  CharacterConversationMode,
  CharacterConversationTurn,
  CharacterKnowledgeItem,
  CharacterMemoryView,
  CharacterStateView,
  CharacterTemplate,
  MeetingContextBudget,
} from "@mandate/domain";
import { DEFAULT_MEETING_CONTEXT_BUDGET } from "@mandate/domain";
import { loadPrompt } from "./prompt-loader";
import { renderPrompt } from "./prompt-renderer";
import { buildBudgetReport, measureSegment, PromptBudgetExceededError } from "./prompt-budget";
import type {
  CharacterContextBudget,
  ComposedPrompt,
  PromptBudgetSegmentReport,
  PromptId,
} from "./types";
import { DEFAULT_CHARACTER_CONTEXT_BUDGET } from "./types";

/**
 * Prompt Composer（ADR-013）。
 * 确定性组合：同一输入必得同一 ComposedPrompt。组合顺序固定（§9.3）：
 * 1 系统安全总纲 → 2/3/4 人物数据 → 5 场合规则 → 6 有限知识 → 7 相关记忆
 * → 8 记忆候选规则 → 9 输出契约；对话输入以 user 消息单独给出。
 * 所有注入数据先经 escapeDataText 中和标签，防止越出数据区。
 */

const MODE_CONTEXT_PROMPT: Readonly<Record<CharacterConversationMode, PromptId>> = {
  "private-audience": "context.private-audience",
  "court-assembly": "context.court-assembly",
  "imperial-council": "context.imperial-council",
  "secret-council": "context.secret-council",
  "memorial-response": "context.memorial-response",
  general: "context.general",
};

const DATA_TAG_PATTERN =
  /<(\/?)(character-data|known-world-state|character-memories|conversation-input|invalid-output)\b/gi;

/** 把数据中的分隔标签中和为全角，确保数据永远越不出数据区 */
export function escapeDataText(text: string): string {
  return text.replace(DATA_TAG_PATTERN, "＜$1$2");
}

/** Phase 4：会议上下文段（§11）。transcript 由调用方按可见性过滤后传入，composer 只做预算裁剪 */
export interface MeetingPromptContext {
  readonly meetingTitle: string;
  readonly meetingTypeLabel: string;
  readonly agendaTitle: string;
  readonly agendaDescription: string;
  readonly currentTurnNumber: number;
  readonly responseModeLabel: string;
  readonly addressedByLabel?: string;
  readonly transcript: readonly {
    readonly turnId: string;
    readonly speakerLabel: string;
    readonly text: string;
  }[];
  /** Phase 5：议程关联的政策模板（供人物荐策引用；渲染入议程段） */
  readonly relatedPolicyTemplateIds?: readonly string[];
  readonly budget?: MeetingContextBudget;
}

export interface CharacterPromptInput {
  readonly scenarioName: string;
  readonly template: CharacterTemplate;
  readonly view: CharacterStateView;
  readonly mode: CharacterConversationMode;
  readonly topic?: string;
  readonly participants: readonly { id: string; name: string }[];
  readonly previousTurns: readonly CharacterConversationTurn[];
  readonly input: { speakerId: string; speakerLabel: string; text: string };
  readonly budget?: CharacterContextBudget;
  /** 提供时进入会议模式：注入议程/席间回合段并附加会议输出契约 */
  readonly meetingContext?: MeetingPromptContext;
}

export function renderMeetingData(
  context: MeetingPromptContext,
  participants: readonly { id: string; name: string }[],
): string {
  return [
    `会议：${context.meetingTitle}（${context.meetingTypeLabel}）`,
    `当前议程：${context.agendaTitle} —— ${context.agendaDescription}`,
    `在场：${participants.map((participant) => participant.name).join("、")}`,
    `此为本次会议第 ${context.currentTurnNumber + 1} 番发言；你被要求的应对方式：${context.responseModeLabel}${
      context.addressedByLabel ? `（由${context.addressedByLabel}指名）` : ""
    }`,
  ].join("\n");
}

export function renderTranscriptData(context: MeetingPromptContext): {
  text: string;
  includedTurns: number;
  trimmedTurns: number;
} {
  const budget = context.budget ?? DEFAULT_MEETING_CONTEXT_BUDGET;
  const capped = context.transcript.slice(-budget.maxRecentTurns);
  const lines: string[] = [];
  let characters = 0;
  let included = 0;
  // 从最近往回收录，预算内尽量多留近期回合
  for (let index = capped.length - 1; index >= 0; index--) {
    const turn = capped[index]!;
    const line = `[${turn.turnId}] ${turn.speakerLabel}：${turn.text}`;
    if (characters + line.length > budget.maxTranscriptCharacters) break;
    lines.unshift(line);
    characters += line.length;
    included++;
  }
  return {
    text: lines.length > 0 ? lines.join("\n") : "（尚无席间发言）",
    includedTurns: included,
    trimmedTurns: context.transcript.length - included,
  };
}

function describeScale(value: number): string {
  if (value >= 80) return "极高";
  if (value >= 60) return "偏高";
  if (value >= 40) return "中等";
  if (value >= 20) return "偏低";
  return "极低";
}

export type CharacterTraitBand = "极低" | "较低" | "中等" | "较高" | "很高";

export function qualitativeBand(value: number): CharacterTraitBand {
  if (value >= 80) return "很高";
  if (value >= 60) return "较高";
  if (value >= 40) return "中等";
  if (value >= 20) return "较低";
  return "极低";
}

function joinList(values: readonly string[]): string {
  return values.length > 0 ? values.join("；") : "（无）";
}

export function renderIdentityData(template: CharacterTemplate, view: CharacterStateView): string {
  const identity = template.identity;
  const lines = [
    `姓名：${template.name}${identity.courtesyName ? `，字${identity.courtesyName}` : ""}`,
    identity.aliases.length > 0 ? `别称：${identity.aliases.join("、")}` : undefined,
    identity.birthplace ? `籍贯：${identity.birthplace}` : undefined,
    identity.socialOrigin ? `出身：${identity.socialOrigin}` : undefined,
    `当前身份：${describeRuntimeStatus(view)}`,
    `生平概略：${template.historicalProfile.summary}`,
    `时誉：${joinList(template.historicalProfile.historicalReputation)}`,
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

function describeRuntimeStatus(view: CharacterStateView): string {
  const statusLabels: Record<string, string> = {
    active: "在朝任事",
    dismissed: "去职在籍",
    imprisoned: "系狱之身",
    exiled: "谪戍在外",
    dead: "已故",
  };
  const office = view.character.currentOfficeId
    ? `现任官职（内部标识：${view.character.currentOfficeId}）`
    : "现无官职";
  return `${statusLabels[view.character.runtimeStatus] ?? view.character.runtimeStatus}，${office}`;
}

export function renderPersonalityData(template: CharacterTemplate): string {
  const p = template.personality;
  const scales: readonly (readonly [string, number])[] = [
    ["胆识", p.courage],
    ["谨慎", p.caution],
    ["野心", p.ambition],
    ["操守", p.integrity],
    ["务实", p.pragmatism],
    ["傲气", p.arrogance],
    ["体恤", p.empathy],
    ["多疑", p.suspicion],
    ["耐性", p.patience],
    ["喜怒不形", p.emotionalControl],
  ];
  const rules = template.behaviorRules;
  return [
    `性情刻度：${scales.map(([label, value]) => `${label}：${qualitativeBand(value)}`).join("，")}`,
    `所重：${joinList(p.values)}`,
    `所惧：${joinList(p.fears)}`,
    `所欲：${joinList(p.desires)}`,
    `所讳：${joinList(p.taboos)}`,
    `自视：${p.selfImage}`,
    `观世：${p.worldview}`,
    `倾向开口：${joinList(rules.likelyToSpeakWhen)}`,
    `倾向缄默：${joinList(rules.likelyToRemainSilentWhen)}`,
    `可能虚饰：${joinList(rules.likelyToLieWhen)}`,
    `倾向推托：${joinList(rules.likelyToDeflectWhen)}`,
    `敢于争执：${joinList(rules.likelyToChallengeWhen)}`,
    `闻之色变：${joinList(rules.reactsStronglyTo)}`,
    `人前行止：${joinList(rules.publicBehavior)}`,
    `人后行止：${joinList(rules.privateBehavior)}`,
    `危局行止：${joinList(rules.crisisBehavior)}`,
    `取舍先后：${joinList(rules.decisionPriorities)}`,
  ].join("\n");
}

export function renderPoliticalData(template: CharacterTemplate): string {
  const profile = template.politicalProfile;
  return [
    `派系：${profile.factionIds.length > 0 ? profile.factionIds.join("、") : "无明确派系"}`,
    `所忠机构：${joinList(profile.institutionalLoyalties)}`,
    `私人效忠：${joinList(profile.personalLoyalties)}`,
    `政敌：${joinList(profile.politicalEnemies)}`,
    `公开主张：${joinList(profile.publicPositions)}`,
    `私下利益（不宣之于口）：${joinList(profile.privateInterests)}`,
    `不可退让之底线：${joinList(profile.redLines)}`,
    `可以商量之事：${joinList(profile.negotiableIssues)}`,
    `对皇上的底色：${profile.attitudeTowardEmperor.baseline}`,
    `随势而变：${joinList(profile.attitudeTowardEmperor.conditions)}`,
  ].join("\n");
}

export function renderCommunicationData(template: CharacterTemplate): string {
  const c = template.communication;
  return [
    `语体刻度：庄重${describeScale(c.formality)}，直白${describeScale(c.directness)}，繁简${describeScale(c.verbosity)}，情绪外露${describeScale(c.emotionality)}，用典${describeScale(c.useOfClassics)}，婉曲${describeScale(c.useOfEuphemism)}`,
    `自称：${c.preferredAddressing.join("、")}`,
    `惯用言路：${joinList(c.commonRhetoricalPatterns)}`,
    `绝不出口的词：${joinList(c.forbiddenModernExpressions)}`,
    `风格参照（不得照搬）：${c.exampleLines.map((line) => `「${line}」`).join(" ")}`,
  ].join("\n");
}

function knowledgeLabel(item: CharacterKnowledgeItem<unknown>): string {
  const statusLabels: Record<string, string> = {
    known: "确知",
    reported: "听闻",
    suspected: "疑闻",
    inferred: "推度",
    outdated: "旧闻",
    contradicted: "有抵牾",
    unknown: "不知",
  };
  const sourceLabels: Record<string, string> = {
    official: "官牍",
    personal: "亲历",
    meeting: "与议",
    memorial: "奏报",
    intelligence: "密报",
    rumor: "风闻",
    inference: "自度",
  };
  return `【${statusLabels[item.status] ?? item.status}·${sourceLabels[item.sourceType] ?? item.sourceType}】`;
}

export function renderKnowledgeData(view: CharacterStateView, maxItems: number): string {
  const lines: string[] = [];
  lines.push(`今日：${view.currentDate}`);

  const self = view.selfState;
  lines.push(
    `自身处境：${describeRuntimeStatus(view)}；心气${describeScale(100 - self.stress)}（压力${describeScale(self.stress)}）；` +
      `自忖圣眷${describeScale(self.perceivedFavor.value + 50)}${knowledgeLabel(self.perceivedFavor)}`,
  );

  const country = view.knownCountryState;
  const countryLines: string[] = [];
  if (country.treasuryTaels) {
    countryLines.push(
      `太仓银约 ${country.treasuryTaels.value} 两${knowledgeLabel(country.treasuryTaels)}`,
    );
  }
  if (country.grainReserveShi) {
    countryLines.push(
      `仓储粮约 ${country.grainReserveShi.value} 石${knowledgeLabel(country.grainReserveShi)}`,
    );
  }
  if (country.militaryReadiness) {
    countryLines.push(
      `武备整饬${describeScale(country.militaryReadiness.value)}${knowledgeLabel(country.militaryReadiness)}`,
    );
  }
  if (country.administrativeCapacity) {
    countryLines.push(
      `吏治运转${describeScale(country.administrativeCapacity.value)}${knowledgeLabel(country.administrativeCapacity)}`,
    );
  }
  if (country.legitimacy) {
    countryLines.push(
      `人心向背${describeScale(country.legitimacy.value)}${knowledgeLabel(country.legitimacy)}`,
    );
  }
  if (country.stability) {
    countryLines.push(
      `海内安靖${describeScale(country.stability.value)}${knowledgeLabel(country.stability)}`,
    );
  }
  lines.push(`国势：${countryLines.length > 0 ? countryLines.join("；") : "所知无几"}`);

  const statusLabels: Record<string, string> = {
    active: "在朝",
    dismissed: "去职",
    imprisoned: "系狱",
    exiled: "谪戍",
    dead: "已故",
  };
  const characters = view.knownCharacters.slice(0, maxItems);
  if (characters.length > 0) {
    lines.push(
      `所知人物：${characters
        .map(
          (item) =>
            `${item.value.name}（${statusLabels[item.value.status] ?? item.value.status}${
              item.value.officeId ? `，职任 ${item.value.officeId}` : ""
            }）${knowledgeLabel(item)}`,
        )
        .join("；")}`,
    );
  }

  const policies = view.knownPolicies.slice(0, maxItems);
  if (policies.length > 0) {
    lines.push(
      `所知政令：${policies
        .map((item) => `${item.value.policyId}（${item.value.status}）${knowledgeLabel(item)}`)
        .join("；")}`,
    );
  }

  const meetings = view.knownMeetings.slice(0, maxItems);
  if (meetings.length > 0) {
    lines.push(
      `所知会议：${meetings
        .map(
          (item) =>
            `${item.value.meetingId}（${item.value.type}，${item.value.status}${
              item.value.participantIds.length > 0
                ? `，与议者 ${item.value.participantIds.join("、")}`
                : ""
            }）${knowledgeLabel(item)}`,
        )
        .join("；")}`,
    );
  }

  const events = view.knownEvents.slice(0, maxItems);
  if (events.length > 0) {
    lines.push(
      `所闻近事：${events.map((item) => `${item.value.eventId}${knowledgeLabel(item)}`).join("；")}`,
    );
  }

  if (view.uncertainties.length > 0) {
    lines.push(
      `自知不明之处：${view.uncertainties
        .map((item) => `${item.topic}（${item.reason}）`)
        .join("；")}`,
    );
  }
  return lines.join("\n");
}

export function renderMemoryData(memories: readonly CharacterMemoryView[]): string {
  if (memories.length === 0) return "（并无相干记忆）";
  const statusLabels: Record<string, string> = {
    active: "",
    outdated: "（已过时）",
    contradicted: "（与所闻有抵牾）",
  };
  return memories
    .map((memory, index) => {
      const doubt = memory.confidence < 50 ? "（未确证）" : "";
      return `${index + 1}. ${doubt}${memory.content}${statusLabels[memory.status] ?? ""}`;
    })
    .join("\n");
}

interface ComposeAttemptInput {
  readonly memoryCount: number;
  readonly turnCount: number;
  readonly knowledgeItemCap: number;
}

export async function composeCharacterPrompt(input: CharacterPromptInput): Promise<ComposedPrompt> {
  const budget = input.budget ?? DEFAULT_CHARACTER_CONTEXT_BUDGET;
  const contextPromptId = MODE_CONTEXT_PROMPT[input.mode];
  const meeting = input.meetingContext;
  const promptIds: readonly PromptId[] = [
    "system.character-agent-base",
    "character.identity",
    "character.personality",
    "character.political-profile",
    "character.communication-style",
    contextPromptId,
    ...(meeting ? (["meeting.agenda-context", "meeting.transcript-context"] as const) : []),
    "knowledge.known-world-state",
    "memory.memory-context",
    "memory.memory-candidate",
    "output.character-response",
    ...(meeting ? (["output.meeting-character-response"] as const) : []),
    "context.conversation-input",
  ];
  const assets = new Map(
    await Promise.all(promptIds.map(async (id) => [id, await loadPrompt(id)] as const)),
  );
  const template = (id: PromptId): string => assets.get(id)!.template;

  const participantsLabel =
    input.participants.length > 0
      ? input.participants.map((participant) => participant.name).join("、")
      : "唯君臣二人";
  const topicLabel = input.topic ?? "未定议题";

  const memoriesAll = input.view.relevantMemories.slice(0, budget.maxMemoryItems);
  const turnsAll = input.previousTurns.slice(-budget.maxConversationTurns);

  const build = (attempt: ComposeAttemptInput) => {
    const memories = memoriesAll.slice(0, attempt.memoryCount);
    const turns = turnsAll.slice(turnsAll.length - attempt.turnCount);

    const segments: { id: string; content: string }[] = [
      {
        id: "system.character-agent-base",
        content: renderPrompt(template("system.character-agent-base"), {
          scenarioName: input.scenarioName,
          currentDate: input.view.currentDate,
          characterName: input.template.name,
        }),
      },
      {
        id: "character.identity",
        content: renderPrompt(template("character.identity"), {
          identityData: escapeDataText(renderIdentityData(input.template, input.view)),
        }),
      },
      {
        id: "character.personality",
        content: renderPrompt(template("character.personality"), {
          personalityData: escapeDataText(renderPersonalityData(input.template)),
        }),
      },
      {
        id: "character.political-profile",
        content: renderPrompt(template("character.political-profile"), {
          politicalData: escapeDataText(renderPoliticalData(input.template)),
        }),
      },
      {
        id: "character.communication-style",
        content: renderPrompt(template("character.communication-style"), {
          communicationData: escapeDataText(renderCommunicationData(input.template)),
        }),
      },
      {
        id: contextPromptId,
        content: renderPrompt(template(contextPromptId), {
          participantsLabel: escapeDataText(participantsLabel),
          topicLabel: escapeDataText(topicLabel),
        }),
      },
      ...(meeting
        ? [
            {
              id: "meeting.agenda-context",
              content: renderPrompt(template("meeting.agenda-context"), {
                meetingData: escapeDataText(renderMeetingData(meeting, input.participants)),
              }),
            },
            {
              id: "meeting.transcript-context",
              content: renderPrompt(template("meeting.transcript-context"), {
                transcriptData: escapeDataText(renderTranscriptData(meeting).text),
              }),
            },
          ]
        : []),
      {
        id: "knowledge.known-world-state",
        content: renderPrompt(template("knowledge.known-world-state"), {
          knowledgeData: escapeDataText(renderKnowledgeData(input.view, attempt.knowledgeItemCap)),
        }),
      },
      {
        id: "memory.memory-context",
        content: renderPrompt(template("memory.memory-context"), {
          memoryData: escapeDataText(renderMemoryData(memories)),
        }),
      },
      { id: "memory.memory-candidate", content: template("memory.memory-candidate") },
      { id: "output.character-response", content: template("output.character-response") },
      ...(meeting
        ? [
            {
              id: "output.meeting-character-response",
              content: template("output.meeting-character-response"),
            },
          ]
        : []),
    ];
    const system = segments.map((segment) => segment.content).join("\n\n");

    const historyMessages = turns.flatMap((turn) => [
      {
        role: "user" as const,
        content: `【前情】${escapeDataText(turn.inputText)}`,
      },
      { role: "assistant" as const, content: escapeDataText(turn.speech) },
    ]);
    const conversationContent = renderPrompt(template("context.conversation-input"), {
      conversationData: escapeDataText(`${input.input.speakerLabel}：${input.input.text}`),
    });
    const messages = [...historyMessages, { role: "user" as const, content: conversationContent }];

    const segmentReports: PromptBudgetSegmentReport[] = [
      ...segments.map((segment) => measureSegment(segment.id, segment.content)),
      measureSegment("conversation", messages.map((message) => message.content).join("\n")),
    ];
    return { system, messages, segmentReports, memories, turns };
  };

  // 裁剪阶梯（§21，累进式）：先减记忆，再减旧对话，最后收紧知识条目；
  // 系统安全段、人物数据与输出契约永不裁剪。
  const fullCap = budget.maxKnowledgeItems;
  const attempts: ComposeAttemptInput[] = [
    { memoryCount: memoriesAll.length, turnCount: turnsAll.length, knowledgeItemCap: fullCap },
    {
      memoryCount: Math.floor(memoriesAll.length / 2),
      turnCount: turnsAll.length,
      knowledgeItemCap: fullCap,
    },
    { memoryCount: 0, turnCount: turnsAll.length, knowledgeItemCap: fullCap },
    { memoryCount: 0, turnCount: Math.floor(turnsAll.length / 2), knowledgeItemCap: fullCap },
    { memoryCount: 0, turnCount: 0, knowledgeItemCap: fullCap },
    { memoryCount: 0, turnCount: 0, knowledgeItemCap: Math.min(fullCap, 20) },
    { memoryCount: 0, turnCount: 0, knowledgeItemCap: Math.min(fullCap, 10) },
    { memoryCount: 0, turnCount: 0, knowledgeItemCap: Math.min(fullCap, 5) },
  ];

  const trimmed: string[] = [];
  let lastTotal = { characters: 0, tokens: 0 };
  for (const attempt of attempts) {
    const built = build(attempt);
    const totalCharacters = built.segmentReports.reduce((sum, item) => sum + item.characters, 0);
    const totalTokens = built.segmentReports.reduce((sum, item) => sum + item.estimatedTokens, 0);
    lastTotal = { characters: totalCharacters, tokens: totalTokens };
    if (totalCharacters <= budget.maxPromptCharacters && totalTokens <= budget.maxEstimatedTokens) {
      if (attempt.memoryCount < memoriesAll.length) {
        trimmed.push(`记忆由 ${memoriesAll.length} 条裁至 ${attempt.memoryCount} 条`);
      }
      if (attempt.turnCount < turnsAll.length) {
        trimmed.push(`历史对话由 ${turnsAll.length} 轮裁至 ${attempt.turnCount} 轮`);
      }
      if (attempt.knowledgeItemCap < budget.maxKnowledgeItems) {
        trimmed.push(`知识条目上限收紧至 ${attempt.knowledgeItemCap}`);
      }
      const promptVersions = Object.fromEntries(
        promptIds.map((id) => [id, assets.get(id)!.version]),
      );
      return {
        system: built.system,
        messages: built.messages,
        manifest: { promptIds, promptVersions },
        budget: buildBudgetReport(built.segmentReports, trimmed, budget),
      };
    }
  }
  throw new PromptBudgetExceededError(
    lastTotal.characters,
    budget.maxPromptCharacters,
    lastTotal.tokens,
    budget.maxEstimatedTokens,
  );
}
