import { z } from "zod";
import { DataConfirmationSchema, TemplateMetaSchema } from "./common";

/**
 * 人物卡历史模板（Phase 3，ADR-010）。
 * 分层：身份 / 历史简介 / 人格 / 政治 / 能力 / 表达 / 行为规则 / 初始关系 / 知识倾向。
 * 红线：
 * - 全部数值维度（0-100）属于游戏建模，不是对历史人物的心理测量；
 *   人物卡 meta.confirmation 必须标注 gameplay-adjusted 或在 notes 中说明数值口径；
 * - 争议评价必须放入 disputedClaims 或以 confirmation=disputed 标注，不得写成确定事实；
 * - 模板运行时只读；运行状态在 GameState.characters，人物记忆在独立记忆仓储。
 */

const IdSchema = z.string().trim().min(1);
const NameSchema = z.string().trim().min(1);
const YearSchema = z.number().int().min(0).max(9_999);
const TextSchema = z.string().trim().min(1);
const TextListSchema = z.array(TextSchema);
/** 游戏建模数值：0-100 整数（gameplay-adjusted） */
const Score100Schema = z.number().int().min(0).max(100);
/** 关系强度：-100..100 整数 */
const StrengthSchema = z.number().int().min(-100).max(100);

export const CharacterGenderSchema = z.enum(["male", "female", "unknown"]);
export type CharacterGender = z.infer<typeof CharacterGenderSchema>;

export const CharacterIdentitySchema = z
  .object({
    courtesyName: NameSchema.optional(),
    artName: NameSchema.optional(),
    dynastyId: IdSchema,
    birthYear: YearSchema.optional(),
    deathYear: YearSchema.optional(),
    birthplace: TextSchema.optional(),
    gender: CharacterGenderSchema.optional(),
    socialOrigin: TextSchema.optional(),
    /** 历史上担任过的官职（引用制度包 office id） */
    historicalOfficeIds: z.array(IdSchema),
    /** 剧本开局官职；null/缺省 = 开局无官职 */
    initialOfficeId: IdSchema.nullable().optional(),
    /** 剧本开局运行状态；缺省 active（开局即"dead"没有意义，故不允许） */
    initialRuntimeStatus: z.enum(["active", "dismissed", "imprisoned", "exiled"]).optional(),
    aliases: z.array(NameSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.birthYear !== undefined &&
      value.deathYear !== undefined &&
      value.deathYear < value.birthYear
    ) {
      context.addIssue({
        code: "custom",
        path: ["deathYear"],
        message: "卒年不得早于生年",
      });
    }
    if (
      value.initialOfficeId &&
      value.initialRuntimeStatus !== undefined &&
      value.initialRuntimeStatus !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["initialOfficeId"],
        message: "非 active 开局状态的人物不得同时持有开局官职",
      });
    }
  });
export type CharacterIdentity = z.infer<typeof CharacterIdentitySchema>;

export const MajorExperienceSchema = z
  .object({
    title: TextSchema,
    description: TextSchema,
    date: TextSchema.optional(),
    sourceIds: z.array(IdSchema).min(1),
    confirmation: DataConfirmationSchema,
  })
  .strict();
export type MajorExperience = z.infer<typeof MajorExperienceSchema>;

export const HistoricalProfileSchema = z
  .object({
    summary: TextSchema,
    majorExperiences: z.array(MajorExperienceSchema),
    /** 历史名声/评价标签；有争议的评价必须进 disputedClaims */
    historicalReputation: TextListSchema,
    disputedClaims: TextListSchema,
  })
  .strict();
export type HistoricalProfile = z.infer<typeof HistoricalProfileSchema>;

export const CharacterPersonalitySchema = z
  .object({
    courage: Score100Schema,
    caution: Score100Schema,
    ambition: Score100Schema,
    integrity: Score100Schema,
    pragmatism: Score100Schema,
    arrogance: Score100Schema,
    empathy: Score100Schema,
    suspicion: Score100Schema,
    patience: Score100Schema,
    emotionalControl: Score100Schema,
    values: TextListSchema,
    fears: TextListSchema,
    desires: TextListSchema,
    taboos: TextListSchema,
    selfImage: TextSchema,
    worldview: TextSchema,
  })
  .strict();
export type CharacterPersonality = z.infer<typeof CharacterPersonalitySchema>;

export const PoliticalProfileSchema = z
  .object({
    factionIds: z.array(IdSchema),
    institutionalLoyalties: TextListSchema,
    personalLoyalties: TextListSchema,
    politicalEnemies: TextListSchema,
    /** 公开立场：本人在朝堂上愿意承认的主张 */
    publicPositions: TextListSchema,
    /** 私下利益：不会公开承认；不得进入其他角色视图 */
    privateInterests: TextListSchema,
    redLines: TextListSchema,
    negotiableIssues: TextListSchema,
    attitudeTowardEmperor: z
      .object({
        baseline: TextSchema,
        conditions: TextListSchema,
      })
      .strict(),
  })
  .strict();
export type PoliticalProfile = z.infer<typeof PoliticalProfileSchema>;

export const CharacterCompetenceSchema = z
  .object({
    administration: Score100Schema,
    finance: Score100Schema,
    military: Score100Schema,
    diplomacy: Score100Schema,
    intelligence: Score100Schema,
    rhetoric: Score100Schema,
    law: Score100Schema,
    factionalPolitics: Score100Schema,
  })
  .strict();
export type CharacterCompetence = z.infer<typeof CharacterCompetenceSchema>;

export const CommunicationProfileSchema = z
  .object({
    formality: Score100Schema,
    directness: Score100Schema,
    verbosity: Score100Schema,
    emotionality: Score100Schema,
    useOfClassics: Score100Schema,
    useOfEuphemism: Score100Schema,
    preferredAddressing: TextListSchema,
    commonRhetoricalPatterns: TextListSchema,
    forbiddenModernExpressions: TextListSchema,
    /** 风格参考示例；不要求模型逐句模仿 */
    exampleLines: z.array(z.string().trim().min(1).max(200)),
  })
  .strict();
export type CommunicationProfile = z.infer<typeof CommunicationProfileSchema>;

export const CharacterBehaviorRulesSchema = z
  .object({
    likelyToSpeakWhen: TextListSchema,
    likelyToRemainSilentWhen: TextListSchema,
    likelyToLieWhen: TextListSchema,
    likelyToDeflectWhen: TextListSchema,
    likelyToChallengeWhen: TextListSchema,
    reactsStronglyTo: TextListSchema,
    publicBehavior: TextListSchema,
    privateBehavior: TextListSchema,
    crisisBehavior: TextListSchema,
    decisionPriorities: TextListSchema,
  })
  .strict();
export type CharacterBehaviorRules = z.infer<typeof CharacterBehaviorRulesSchema>;

export const CharacterRelationKindSchema = z.enum([
  "ally",
  "patron",
  "protege",
  "rival",
  "enemy",
  "kinship",
  "colleague",
]);
export type CharacterRelationKind = z.infer<typeof CharacterRelationKindSchema>;

export const InitialCharacterRelationSchema = z
  .object({
    targetCharacterId: IdSchema,
    kind: CharacterRelationKindSchema,
    strength: StrengthSchema,
    /** 关系的历史依据说明 */
    basis: TextSchema,
    confirmation: DataConfirmationSchema,
  })
  .strict();
export type InitialCharacterRelation = z.infer<typeof InitialCharacterRelationSchema>;

export const KnowledgeAccessLevelSchema = z.enum(["none", "limited", "normal", "privileged"]);
export type KnowledgeAccessLevel = z.infer<typeof KnowledgeAccessLevelSchema>;

export const CharacterKnowledgeProfileSchema = z
  .object({
    specialistDomains: TextListSchema,
    familiarRegions: TextListSchema,
    informationChannels: TextListSchema,
    accessLevels: z.array(
      z
        .object({
          domain: IdSchema,
          level: KnowledgeAccessLevelSchema,
        })
        .strict(),
    ),
    commonBiases: TextListSchema,
    blindSpots: TextListSchema,
  })
  .strict();
export type CharacterKnowledgeProfile = z.infer<typeof CharacterKnowledgeProfileSchema>;

export const CharacterTemplateSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    identity: CharacterIdentitySchema,
    historicalProfile: HistoricalProfileSchema,
    personality: CharacterPersonalitySchema,
    politicalProfile: PoliticalProfileSchema,
    competence: CharacterCompetenceSchema,
    communication: CommunicationProfileSchema,
    behaviorRules: CharacterBehaviorRulesSchema,
    initialRelations: z.array(InitialCharacterRelationSchema),
    knowledgeProfile: CharacterKnowledgeProfileSchema,
    meta: TemplateMetaSchema,
  })
  .strict();
export type CharacterTemplate = z.infer<typeof CharacterTemplateSchema>;
