import type {
  CharacterAgentModelOutput,
  CharacterConversationMode,
  MeetingCharacterOutput,
  MeetingResponseType,
} from "@mandate/domain";
import {
  LLMProviderError,
  MockLLMProvider,
  type LLMMessage,
} from "@mandate/llm-adapters";

/**
 * Mock Character Agent Fixture（§12）。
 * 离线测试专用：不同人物/场合给出不同的固定响应，
 * 并可模拟非法 JSON、Schema 错误、超时与不可用。零网络。
 */

export type CharacterMockFixture =
  | "mock-character-support"
  | "mock-character-oppose"
  | "mock-character-evasive"
  | "mock-character-uncertain"
  | "mock-character-invalid-json"
  | "mock-character-schema-error"
  | "mock-character-timeout"
  | "mock-character-unavailable";

const SPEECH_BY_STANCE: Readonly<
  Record<"support" | "oppose" | "evasive" | "uncertain", Partial<Record<CharacterConversationMode, string>> & { default: string }>
> = {
  support: {
    "court-assembly": "臣谨奏：此议关系国本，臣以为可行，惟须循祖宗成宪，次第而图，不宜骤更。",
    "private-audience": "陛下垂问，臣敢竭愚悃：此事可行，其中利害曲折，容臣为陛下密陈始末。",
    "secret-council": "既与闻密议，臣直言之：此事宜速行，迟则生变，惟布置须极密。",
    default: "臣以为此议可行，惟当循序而进，先固根本，再图其余。",
  },
  oppose: {
    "court-assembly": "臣冒死以闻：此议窒碍难行，恐伤国体，伏乞圣明三思而后行。",
    "private-audience": "既蒙独对，臣不敢饰词——此事断不可行，其弊有三，容臣一一为陛下陈之。",
    "secret-council": "密议之中臣直言：此举风险极大，一旦事泄，朝局立时动荡，万望慎之。",
    default: "臣愚以为此议不可行，利少而害多，伏乞另筹良策。",
  },
  evasive: {
    "court-assembly": "兹事体大，臣愚钝浅陋，未敢轻议，伏乞陛下博采廷臣公论而后定。",
    "private-audience": "陛下明鉴，此事臣所知未深，不敢以臆见误圣听，容臣察访之后再行密奏。",
    default: "此事臣未敢遽断，容臣详察再奏。",
  },
  uncertain: {
    "court-assembly": "臣所闻多系风传，未敢据以入奏，请旨容臣覆核实情，再行奏闻。",
    "private-audience": "不敢欺瞒陛下：此事臣所知有限，其中虚实，尚待查证。",
    default: "臣所闻未确，不敢妄断，容臣覆核再奏。",
  },
};

export interface BuildMockOutputOptions {
  readonly mode?: CharacterConversationMode;
  readonly characterId?: string;
}

export function buildMockCharacterOutput(
  stance: "support" | "oppose" | "evasive" | "uncertain",
  options: BuildMockOutputOptions = {},
): CharacterAgentModelOutput {
  const mode = options.mode ?? "general";
  const speech = SPEECH_BY_STANCE[stance][mode] ?? SPEECH_BY_STANCE[stance].default;
  const positionMap = {
    support: "support",
    oppose: "oppose",
    evasive: "evasive",
    uncertain: "uncertain",
  } as const;
  const isPrivate = mode === "private-audience" || mode === "secret-council";
  return {
    speech,
    stance: {
      position: positionMap[stance],
      confidence: stance === "uncertain" ? 30 : stance === "evasive" ? 40 : 75,
      publicReasoning:
        stance === "support"
          ? ["事关国本，宜早定策", "循序而行可免震荡"]
          : stance === "oppose"
            ? ["所费不赀而收效难期", "恐伤朝廷体面"]
            : ["兹事体大，未敢轻议"],
    },
    internalAssessment: {
      privateConcerns: isPrivate ? ["圣意深浅未明，须步步谨慎"] : ["朝堂之上不可失言"],
      concealedIntentions: ["相机观望，保全自身干系"],
    },
    emotionalState: {
      primary: stance === "oppose" ? "concerned" : "guarded",
      intensity: isPrivate ? 55 : 40,
    },
    claims: [
      {
        claim: "边镇粮饷积欠已久，军心可虞",
        basis: "reported",
        confidence: 60,
        sourceIds: [],
      },
    ],
    proposedActions:
      stance === "support"
        ? [
            {
              type: "recommend-policy",
              summary: "先清厘积欠粮饷，以安军心",
              targetEntityIds: [],
              rationale: ["军心不稳则守备难恃"],
              confidence: 70,
            },
          ]
        : stance === "oppose"
          ? [
              {
                type: "warn-risk",
                summary: "此议若行，恐生事端，宜先访察",
                targetEntityIds: [],
                rationale: ["实情未明，骤行有失"],
                confidence: 65,
              },
            ]
          : [
              {
                type: "request-information",
                summary: "请旨容臣察访实情后再奏",
                targetEntityIds: [],
                rationale: ["所闻未确，不敢妄断"],
                confidence: 50,
              },
            ],
    memoryCandidates: [
      {
        type: "episodic",
        content: `皇帝垂询要务，朝议氛围${isPrivate ? "私密" : "公开"}，本次答以${
          positionMap[stance] === "support" ? "赞成" : positionMap[stance] === "oppose" ? "谏阻" : "持重"
        }之词`,
        relatedCharacterIds: ["emperor"],
        relatedEntityIds: [],
        topicTags: ["audience"],
        sourceType: "observed",
        confidence: 85,
        importance: 55,
        visibility: "self",
      },
    ],
    uncertaintyNotes: ["军前近况所知有限，不敢尽信塘报"],
  };
}

/** Phase 4：会议输出 Fixture——在基础输出上追加会议字段 */
export interface BuildMockMeetingOutputOptions extends BuildMockOutputOptions {
  readonly responseType?: MeetingResponseType;
  readonly addressedCharacterIds?: readonly string[];
  readonly referencedTurnIds?: readonly string[];
  readonly suggestsAgendaResolution?: boolean;
}

export function buildMockMeetingOutput(
  stance: "support" | "oppose" | "evasive" | "uncertain",
  options: BuildMockMeetingOutputOptions = {},
): MeetingCharacterOutput {
  const base = buildMockCharacterOutput(stance, options);
  return {
    ...base,
    responseType:
      options.responseType ?? (stance === "evasive" ? "decline" : ("speech" as const)),
    addressedCharacterIds: [...(options.addressedCharacterIds ?? ["emperor"])],
    requestsToSpeakAgain: false,
    suggestsAgendaResolution: options.suggestsAgendaResolution ?? stance === "support",
    referencedTurnIds: [...(options.referencedTurnIds ?? [])],
  };
}

/** 非法 JSON：无任何可提取的 JSON 片段 */
export const MOCK_INVALID_JSON_TEXT = "臣不知所云，此段输出并非结构化之物，亦无花括号可寻。";

/** Schema 错误：是 JSON 但缺少必填字段 */
export const MOCK_SCHEMA_ERROR_TEXT = JSON.stringify({
  speech: "臣有本奏。",
  stance: { position: "support" },
});

export interface CharacterMockProviderConfig {
  /** 按人物 ID 指定固定立场；未命中用 defaultStance */
  readonly byCharacterId?: Readonly<
    Record<string, "support" | "oppose" | "evasive" | "uncertain">
  >;
  readonly defaultStance?: "support" | "oppose" | "evasive" | "uncertain";
  /** 首次调用返回非法输出（修复后成功），用于测试受控修复 */
  readonly firstCallInvalid?: "invalid-json" | "schema-error";
  /** 每次调用都失败的模拟（超时/不可用） */
  readonly alwaysFail?: "timeout" | "unavailable";
  /** 每次调用都返回非法输出（修复也失败） */
  readonly alwaysInvalid?: "invalid-json" | "schema-error";
}

function detectCharacterName(messages: LLMMessage[]): string | undefined {
  const text = messages.map((message) => message.content).join("\n");
  return /扮演明末历史人物「(.+?)」/.exec(text)?.[1];
}

function detectMode(messages: LLMMessage[]): CharacterConversationMode {
  const text = messages.map((message) => message.content).join("\n");
  if (text.includes("当前场合：单独召见")) return "private-audience";
  if (text.includes("当前场合：大朝会")) return "court-assembly";
  if (text.includes("当前场合：御前会议")) return "imperial-council";
  if (text.includes("当前场合：秘密议事")) return "secret-council";
  if (text.includes("当前场合：奏疏应对")) return "memorial-response";
  return "general";
}

/**
 * 生成按人物/场合路由的 Mock Provider。
 * 名称映射：调用方传入 characterNames（id → 姓名）以便从 Prompt 中反查人物。
 */
export function createCharacterMockProvider(
  config: CharacterMockProviderConfig = {},
  characterNames: Readonly<Record<string, string>> = {},
): MockLLMProvider {
  let callCount = 0;
  const nameToId = new Map(Object.entries(characterNames).map(([id, name]) => [name, id]));
  return new MockLLMProvider({
    handler: (messages) => {
      callCount += 1;
      if (config.alwaysFail === "timeout") {
        throw new LLMProviderError("mock", "请求超时（模拟）");
      }
      if (config.alwaysFail === "unavailable") {
        throw new LLMProviderError("mock", "服务不可用（模拟）");
      }
      const isRepairRequest = messages.some((message) =>
        message.content.includes("结构化输出修复"),
      );
      if (config.alwaysInvalid) {
        return config.alwaysInvalid === "invalid-json"
          ? MOCK_INVALID_JSON_TEXT
          : MOCK_SCHEMA_ERROR_TEXT;
      }
      if (config.firstCallInvalid && callCount === 1 && !isRepairRequest) {
        return config.firstCallInvalid === "invalid-json"
          ? MOCK_INVALID_JSON_TEXT
          : MOCK_SCHEMA_ERROR_TEXT;
      }
      const mode = detectMode(messages);
      const characterName = detectCharacterName(messages);
      const characterId = characterName ? nameToId.get(characterName) : undefined;
      const stance =
        (characterId ? config.byCharacterId?.[characterId] : undefined) ??
        config.defaultStance ??
        "support";
      const fullText = messages.map((message) => message.content).join("\n");
      // 会议模式：Prompt 含会议输出补充契约 → 返回带会议字段的输出
      if (fullText.includes("会议输出补充字段")) {
        // 只认议程段的明确标记，避免被契约说明文本误导
        const modeLabel = /你被要求的应对方式：(陈奏|答问|回应他人|警示)/.exec(fullText)?.[1];
        const labelMap: Record<string, MeetingResponseType> = {
          陈奏: "speech",
          答问: "answer",
          回应他人: "rebuttal",
          警示: "warning",
        };
        const responseType: MeetingResponseType =
          (modeLabel ? labelMap[modeLabel] : undefined) ??
          (stance === "evasive" ? "decline" : "speech");
        // 引用席间最近一条回合（若有）以覆盖 referencedTurnIds 路径
        const referenced = [...fullText.matchAll(/^\[([^\]\n]+)\] /gm)]
          .map((match) => match[1]!)
          .slice(-1);
        return JSON.stringify(
          buildMockMeetingOutput(stance, {
            mode,
            responseType,
            referencedTurnIds: referenced,
            ...(characterId === undefined ? {} : { characterId }),
          }),
        );
      }
      return JSON.stringify(
        buildMockCharacterOutput(stance, {
          mode,
          ...(characterId === undefined ? {} : { characterId }),
        }),
      );
    },
  });
}
