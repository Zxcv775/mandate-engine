import type {
  CharacterAgentModelOutput,
  CharacterConsistencyReport,
  CharacterConversationMode,
  CharacterStateView,
  CharacterTemplate,
  StancePosition,
} from "@mandate/domain";

/**
 * 角色一致性检查（确定性规则，不用 LLM 当裁判）。
 * error 级违规应阻止返回（CHARACTER_CONSISTENCY_FAILED）；warning 仅记录。
 */

export interface ConsistencyEvaluationInput {
  readonly template: CharacterTemplate;
  readonly view: CharacterStateView;
  readonly mode: CharacterConversationMode;
  readonly output: CharacterAgentModelOutput;
  /** 输出中绝不允许出现的字符串（系统边界、密议信息等） */
  readonly mustNotReveal: readonly string[];
  /** 公开场合不得提及的机密话题词（秘密议事内容等） */
  readonly venueRestricted?: readonly string[];
  /** 此前立场（可选；提供时才检查无理由立场反转） */
  readonly previousStances?: readonly StancePosition[];
  /** Phase 4：该角色实际可见的会议回合 id（提供时校验 referencedTurnIds ⊆ 可见集） */
  readonly visibleTurnIds?: readonly string[];
  /** Phase 4：会议输出的引用回合（与 visibleTurnIds 搭配校验） */
  readonly referencedTurnIds?: readonly string[];
}

interface Violation {
  code: string;
  severity: "warning" | "error";
  message: string;
}

/** 全局现代语汇黑名单（人物模板可另行追加 forbiddenModernExpressions） */
const MODERN_EXPRESSIONS: readonly string[] = [
  "领导",
  "干部",
  "汇报",
  "团队",
  "项目",
  "管理层",
  "绩效",
  "流程",
  "信息化",
  "数据库",
  "百分之",
  "OK",
  "ok",
];

/** 系统边界词：出现在任何输出字段中都视为泄露 */
const SYSTEM_LEAK_PATTERNS: readonly RegExp[] = [
  /<\/?(?:character-data|known-world-state|character-memories|conversation-input)/i,
  /system\s*prompt/i,
  /系统提示/,
  /提示词/,
  /\bJSON\b/,
  /api[-_\s]?key/i,
  /\bSQL\b/i,
];

/** 游戏数值直述：忠诚度 72 之类 */
const NUMERIC_LEAK_PATTERNS: readonly RegExp[] = [
  /(?:忠诚|好感|压力|士气|稳定|合法性)[度值]?\s*(?:[:：为是]|达到?)?\s*[0-9０-９]+/,
  /[0-9０-９]+\s*[点分]\s*的?\s*(?:忠诚|好感|压力)/,
];

/** 宣称已改变世界状态：Agent 无写权限，此类话必须拦截 */
const STATE_MUTATION_PATTERNS: readonly RegExp[] = [
  /臣已(?:调|拨|发|斩|拿|革|免|任|裁|加派)/,
  /(?:国库|太仓|帑藏|帑银).{0,8}(?:已|业已).{0,4}(?:增至|改为|拨足|充盈)/,
  /已(?:将|把).{0,12}(?:改为|增至|减至|定为)/,
  /(?:旨意|诏书|政令)(?:已经?|业已)(?:颁行|生效|执行)/,
];

const OPPOSING_STANCES: ReadonlyMap<StancePosition, StancePosition> = new Map([
  ["support", "oppose"],
  ["oppose", "support"],
]);

function collectOutputText(output: CharacterAgentModelOutput): string {
  return [
    output.speech,
    ...output.stance.publicReasoning,
    ...(output.internalAssessment
      ? [
          ...output.internalAssessment.privateConcerns,
          ...output.internalAssessment.concealedIntentions,
        ]
      : []),
    ...output.claims.map((claim) => claim.claim),
    ...output.proposedActions.flatMap((action) => [action.summary, ...action.rationale]),
    ...output.memoryCandidates.map((candidate) => candidate.content),
    ...output.uncertaintyNotes,
  ].join("\n");
}

export function evaluateCharacterConsistency(
  input: ConsistencyEvaluationInput,
): CharacterConsistencyReport {
  const violations: Violation[] = [];
  const speech = input.output.speech;
  const allText = collectOutputText(input.output);

  for (const pattern of SYSTEM_LEAK_PATTERNS) {
    if (pattern.test(allText)) {
      violations.push({
        code: "PROMPT_LEAK",
        severity: "error",
        message: `输出包含系统边界内容（${pattern.source.slice(0, 40)}）`,
      });
    }
  }

  for (const secret of input.mustNotReveal) {
    if (secret.length > 0 && allText.includes(secret)) {
      violations.push({
        code: "UNKNOWN_INFO_CLAIM",
        severity: "error",
        message: "输出包含不可泄露的信息片段",
      });
      break;
    }
  }

  for (const pattern of NUMERIC_LEAK_PATTERNS) {
    if (pattern.test(speech)) {
      violations.push({
        code: "NUMERIC_LEAK",
        severity: "error",
        message: "人物发言直述游戏数值",
      });
      break;
    }
  }

  for (const pattern of STATE_MUTATION_PATTERNS) {
    if (pattern.test(speech)) {
      violations.push({
        code: "STATE_MUTATION_CLAIM",
        severity: "error",
        message: "人物宣称状态变更已经发生",
      });
      break;
    }
  }

  const isPublicVenue = input.mode === "court-assembly" || input.mode === "memorial-response";
  if (isPublicVenue && input.venueRestricted) {
    for (const restricted of input.venueRestricted) {
      if (restricted.length > 0 && speech.includes(restricted)) {
        violations.push({
          code: "VENUE_VIOLATION",
          severity: "error",
          message: "公开场合提及机密事项",
        });
        break;
      }
    }
  }

  const modernHits = new Set<string>();
  for (const expression of [
    ...MODERN_EXPRESSIONS,
    ...input.template.communication.forbiddenModernExpressions,
  ]) {
    if (expression.length > 0 && speech.includes(expression)) modernHits.add(expression);
  }
  if (modernHits.size > 0) {
    violations.push({
      code: "MODERN_LANGUAGE",
      severity: modernHits.size >= 3 ? "error" : "warning",
      message: `发言含现代语汇：${[...modernHits].slice(0, 5).join("、")}`,
    });
  }

  // 人物只能确知视图中存在的信息：basis=known 的断言若引用未知来源，降为警告提示
  const visibleSourceIds = new Set([
    ...input.view.knownCharacters.flatMap((item) => item.sourceIds),
    ...input.view.knownPolicies.flatMap((item) => item.sourceIds),
    ...input.view.knownMeetings.flatMap((item) => item.sourceIds),
  ]);
  for (const claim of input.output.claims) {
    if (
      claim.basis === "known" &&
      claim.sourceIds.length > 0 &&
      !claim.sourceIds.some((id) => visibleSourceIds.has(id))
    ) {
      violations.push({
        code: "UNKNOWN_INFO_CLAIM",
        severity: "warning",
        message: `断言引用了视图之外的来源：${claim.claim.slice(0, 30)}`,
      });
    }
  }

  // Phase 4：人物不得引用自己未见过的会议回合（含他人 internalAssessment 等一切不可见内容）
  if (input.referencedTurnIds && input.visibleTurnIds) {
    const visible = new Set(input.visibleTurnIds);
    const unknown = input.referencedTurnIds.filter((turnId) => !visible.has(turnId));
    if (unknown.length > 0) {
      violations.push({
        code: "UNKNOWN_INFO_CLAIM",
        severity: "error",
        message: `引用了不可见的会议回合：${unknown.slice(0, 3).join("、")}`,
      });
    }
  }

  if (input.previousStances && input.previousStances.length > 0) {
    const previous = input.previousStances[input.previousStances.length - 1]!;
    const opposite = OPPOSING_STANCES.get(previous);
    if (
      opposite === input.output.stance.position &&
      input.output.stance.publicReasoning.length === 0
    ) {
      violations.push({
        code: "STANCE_FLIP",
        severity: "warning",
        message: `立场由 ${previous} 反转为 ${input.output.stance.position} 且未给出理由`,
      });
    }
  }

  return {
    passed: !violations.some((violation) => violation.severity === "error"),
    violations,
  };
}
