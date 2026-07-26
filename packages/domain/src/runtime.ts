import type { Modifier } from "./common";
import type { Meeting } from "./meeting";

/**
 * 运行时实体（可修改实例，存于 SQLite 存档）。
 * 初始值由模板实例化而来，之后与模板脱钩（玩家可改变历史）。
 */

/** 国家总体状态 */
export interface Country {
  id: string;
  name: string;
  dynastyId: string;
  rulerCharacterId: string;
  /** 国库（银两） */
  treasury: number;
  /** 粮食储备（石） */
  grainReserves: number;
  /** 稳定度 0-100 */
  stability: number;
  /** 威望 0-100 */
  prestige: number;
  /** 腐败指数 0-100（越高越腐败） */
  corruptionIndex: number;
  /** 行政效率 0-100 */
  adminEfficiency: number;
}

/** 地区（省级单元）状态 */
export interface Region {
  id: string;
  name: string;
  population: number;
  agriculture: number;
  commerce: number;
  /** 税基（年额定银两） */
  taxBase: number;
  /** 治安/民心 0-100 */
  publicOrder: number;
  /** 驻军规模 */
  garrisonStrength: number;
  /** 灾害风险 0-1 */
  disasterRisk: number;
  /** 中央控制度 0-100（影响政策执行偏差） */
  controlLevel: number;
}

/** 人物运行时状态（模板字段见 Character） */
export interface CharacterState {
  characterId: string;
  alive: boolean;
  locationRegionId?: string;
  currentOfficeId?: string;
  /** 表观忠诚 0-100（玩家可见；真实忠诚在 HiddenState） */
  loyalty: number;
  /** 对皇帝的畏惧 0-100 */
  fearOfEmperor: number;
  /** 对皇帝的态度 -100..100 */
  attitudeToEmperor: number;
  factionId?: string;
  memoryIds: string[];
}

/** 官职任职（运行时） */
export interface OfficeHolder {
  officeId: string;
  characterId: string;
  appointedAtGameDate: string;
}

/** 派系运行时状态 */
export interface FactionState {
  factionId: string;
  /** 影响力 0-100 */
  influence: number;
  /** 凝聚力 0-100 */
  cohesion: number;
  memberIds: string[];
}

export type RelationshipKind = "trust" | "hostility" | "kinship" | "mentor" | "ally";

/** 人物关系（运行时） */
export interface Relationship {
  fromCharacterId: string;
  toCharacterId: string;
  kind: RelationshipKind;
  /** -100..100 */
  strength: number;
  /** 是否对玩家未知 */
  hidden: boolean;
}

export type MemorialStatus = "unread" | "read" | "retained" | "responded";

/**
 * 奏折。content/title 可由 LLM 生成（白名单），
 * status 等状态字段由系统管理；truthfulness 为隐藏值，不进玩家视图。
 */
export interface Memorial {
  id: string;
  authorCharacterId: string;
  gameDate: string;
  title: string;
  content: string;
  category: string;
  /** 作者陈述的可信度 0-1（隐藏） */
  truthfulness: number;
  status: MemorialStatus;
  imperialResponse?: string;
  requiresDecision: boolean;
}

/** 情报报告（厂卫/密折等渠道） */
export interface IntelligenceReport {
  id: string;
  sourceInstitutionId: string;
  gameDate: string;
  content: string;
  /** 准确度 0-1（隐藏值，玩家不可见） */
  accuracy: number;
  scope: string[];
}

export type PolicyStatus = "draft" | "issued" | "executing" | "suspended" | "repealed";

/**
 * 政策。LLM 仅可生成 draft 草案（经 Schema + 制度校验 + 玩家裁决），
 * 数值效果由规则引擎换算为 Modifier 后生效（ADR-002）。
 */
export interface Policy {
  id: string;
  name: string;
  description: string;
  status: PolicyStatus;
  targetRegionIds: string[] | "all";
  modifiers: Modifier[];
  /** 合法性成本/收益（受会议类型修正） */
  legitimacyCost: number;
  /** 执行阻力 0-100 */
  executionResistance: number;
  issuedAtGameDate?: string;
}

export type DecreeStatus = "drafted" | "issued" | "executed" | "resisted";

/** 圣旨/诏令 */
export interface ImperialDecree {
  id: string;
  gameDate: string;
  content: string;
  relatedPolicyId?: string;
  addressee: string;
  status: DecreeStatus;
}

/** 军队 */
export interface Army {
  id: string;
  name: string;
  regionId: string;
  size: number;
  /** 士气 0-100 */
  morale: number;
  /** 补给 0-100 */
  supply: number;
  /** 欠饷月数（影响士气与哗变风险） */
  payArrearsMonths: number;
  commanderCharacterId?: string;
}

export type WarStatus = "active" | "truce" | "ended";

/** 战争（MVP 为回合制简化推演） */
export interface War {
  id: string;
  name: string;
  belligerentFactionIds: string[];
  frontRegionIds: string[];
  status: WarStatus;
  startedAtGameDate: string;
}

export type MemoryKind = "short_term" | "long_term" | "meeting_record";

/** 记忆条目（ownerId 为 characterId / "player" / "narrator"） */
export interface Memory {
  id: string;
  ownerId: string;
  kind: MemoryKind;
  content: string;
  /** 重要性 0-100（记忆压缩依据） */
  importance: number;
  createdAtGameDate: string;
}

/** 游戏会话（一局游戏的元信息） */
export interface GameSession {
  id: string;
  scenarioId: string;
  playerName?: string;
  /** 随机种子：复现判定序列的锚点（FR-RULE-001） */
  rngSeed: number;
  startedAtRealTime: string;
  settings: {
    difficulty: "normal" | "hard";
  };
}

/** 隐藏状态：对玩家与无权限 NPC 均不可见（FR-STATE-003） */
export interface HiddenState {
  /** characterId → 真实忠诚 */
  trueLoyalty: Record<string, number>;
  /** 标记键 → 阴谋/风险累积值 */
  conspiracyFlags: Record<string, number>;
  /** 标记键 → 泄密累积 */
  leakAccumulators: Record<string, number>;
}

/**
 * GameState：单一事实源（Single Source of Truth）。
 * 一切模块读取本对象；一切修改经状态引擎并写入 StateChangeLog。
 */
export interface GameState {
  sessionId: string;
  /** 游戏内日期（公历 ISO 字符串） */
  currentGameDate: string;
  turn: number;
  country: Country;
  regions: Region[];
  characters: CharacterState[];
  officeHolders: OfficeHolder[];
  factions: FactionState[];
  relationships: Relationship[];
  policies: Policy[];
  activeMeeting?: Meeting;
  armies: Army[];
  wars: War[];
  firedEventIds: string[];
  hidden: HiddenState;
}

/** 单条状态变更记录 */
export interface StateChange {
  path: string;
  before: unknown;
  after: unknown;
}

export type StateChangeActor = "player" | "system" | "rule_engine";

/**
 * StateChangeLog：一切状态修改的审计记录，只增不改。
 */
export interface StateChangeLog {
  id: string;
  sessionId: string;
  realTimestamp: string;
  gameDate: string;
  turn: number;
  actor: StateChangeActor;
  summary: string;
  changes: StateChange[];
  /** 参与结算的规则/Modifier 引用（溯源用） */
  ruleRefs: string[];
}
