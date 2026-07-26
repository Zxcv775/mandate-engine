import type {
  CharacterMemory,
  CharacterTemplate,
  GameState,
} from "@mandate/domain";
import {
  FixedClock,
  createInitialGameState,
  type ScenarioInitializationBundle,
} from "@mandate/game-engine";

/** Phase 3 测试共享 Fixture：最小合法人物卡与测试 GameState（确定性，无网络）。 */

export const FIXTURE_NOW = "2026-07-26T00:00:00.000Z";

export function makeCharacterTemplate(
  overrides: Partial<CharacterTemplate> & Pick<CharacterTemplate, "id" | "name">,
): CharacterTemplate {
  return {
    identity: {
      dynastyId: "ming",
      historicalOfficeIds: [],
      initialOfficeId: null,
      aliases: [],
      ...overrides.identity,
    },
    historicalProfile: {
      summary: "测试人物简介",
      majorExperiences: [],
      historicalReputation: [],
      disputedClaims: [],
      ...overrides.historicalProfile,
    },
    personality: {
      courage: 50,
      caution: 50,
      ambition: 50,
      integrity: 50,
      pragmatism: 50,
      arrogance: 50,
      empathy: 50,
      suspicion: 50,
      patience: 50,
      emotionalControl: 50,
      values: ["忠君"],
      fears: ["失势"],
      desires: ["保位"],
      taboos: ["失仪"],
      selfImage: "谨慎之臣",
      worldview: "朝局如棋",
      ...overrides.personality,
    },
    politicalProfile: {
      factionIds: [],
      institutionalLoyalties: [],
      personalLoyalties: [],
      politicalEnemies: [],
      publicPositions: ["谨守祖制"],
      privateInterests: ["保全身家"],
      redLines: ["背君"],
      negotiableIssues: [],
      attitudeTowardEmperor: { baseline: "恭顺", conditions: [] },
      ...overrides.politicalProfile,
    },
    competence: {
      administration: 50,
      finance: 50,
      military: 50,
      diplomacy: 50,
      intelligence: 50,
      rhetoric: 50,
      law: 50,
      factionalPolitics: 50,
      ...overrides.competence,
    },
    communication: {
      formality: 70,
      directness: 50,
      verbosity: 40,
      emotionality: 30,
      useOfClassics: 50,
      useOfEuphemism: 60,
      preferredAddressing: ["臣"],
      commonRhetoricalPatterns: ["引经据典"],
      forbiddenModernExpressions: ["加油"],
      exampleLines: ["臣谨奏。"],
      ...overrides.communication,
    },
    behaviorRules: {
      likelyToSpeakWhen: ["被垂询"],
      likelyToRemainSilentWhen: ["党争"],
      likelyToLieWhen: [],
      likelyToDeflectWhen: ["不知之事"],
      likelyToChallengeWhen: [],
      reactsStronglyTo: ["弹劾"],
      publicBehavior: ["持重"],
      privateBehavior: ["探听"],
      crisisBehavior: ["乞休"],
      decisionPriorities: ["自保"],
      ...overrides.behaviorRules,
    },
    initialRelations: overrides.initialRelations ?? [],
    knowledgeProfile: {
      specialistDomains: ["朝政"],
      familiarRegions: ["京师"],
      informationChannels: ["邸报"],
      accessLevels: [],
      commonBiases: [],
      blindSpots: [],
      ...overrides.knowledgeProfile,
    },
    meta: overrides.meta ?? {
      sourceIds: ["ming-shi"],
      confirmation: "gameplay-adjusted",
      notes: "测试 fixture，数值为游戏建模。",
    },
    id: overrides.id,
    name: overrides.name,
  };
}

export interface FixtureBundleOptions {
  offices?: ScenarioInitializationBundle["offices"];
  institutions?: ScenarioInitializationBundle["institutions"];
}

export function makeFixtureBundle(
  characters?: readonly CharacterTemplate[],
  options: FixtureBundleOptions = {},
): ScenarioInitializationBundle {
  return {
    scenario: {
      id: "chongzhen-early",
      name: "崇祯初政",
      dynastyId: "ming",
      startGameDate: "1627-10-02",
      synopsis: "test",
      initialDataRef: "data/scenarios/chongzhen-early/",
      coreCharacterIds: (characters ?? [defaultFixtureCharacter()]).map((value) => value.id),
      status: "prototype",
      historicalDataCompleteness: "placeholder",
      meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
    },
    dynasty: {
      id: "ming",
      name: "明",
      startYear: 1368,
      endYear: 1644,
      institutionPackId: "ming-standard",
      meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
    },
    characters: characters ?? [defaultFixtureCharacter()],
    offices: options.offices ?? [
      {
        id: "chief-grand-secretary",
        name: "内阁首辅",
        grade: 1,
        institutionId: "nei-ge",
        powers: ["票拟"],
        quota: 1,
        meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
      },
    ],
    institutions: options.institutions ?? [
      {
        id: "nei-ge",
        name: "内阁",
        type: "decision",
        functions: ["票拟"],
        meta: { sourceIds: ["ming-shi"], confirmation: "confirmed" },
      },
    ],
    historicalSources: [],
  };
}

export function defaultFixtureCharacter(): CharacterTemplate {
  return makeCharacterTemplate({ id: "wei-zhongxian", name: "魏忠贤" });
}

export function makeFixtureState(
  characters?: readonly CharacterTemplate[],
  options: FixtureBundleOptions & { saveId?: string; seed?: string } = {},
): GameState {
  return createInitialGameState(
    makeFixtureBundle(characters, options),
    { saveId: options.saveId ?? "save_demo", seed: options.seed ?? "demo-seed" },
    new FixedClock(FIXTURE_NOW),
  );
}

export function makeMemory(
  overrides: Partial<CharacterMemory> & Pick<CharacterMemory, "memoryId">,
): CharacterMemory {
  return {
    saveId: "save_demo",
    characterId: "wei-zhongxian",
    type: "episodic",
    content: `测试记忆内容 ${overrides.memoryId}`,
    relatedCharacterIds: [],
    relatedEntityIds: [],
    topicTags: [],
    sourceRevision: 0,
    sourceType: "observed",
    confidence: 80,
    importance: 50,
    visibility: "self",
    status: "active",
    createdAt: FIXTURE_NOW,
    recallCount: 0,
    ...overrides,
  };
}
