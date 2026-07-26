import type { Modifier, TemplateMeta } from "./common";

/**
 * 模板侧实体（只读，存于 data/，git 版本控制）。
 * 红线：运行时禁止修改模板（FR-HIST-002 / ADR-004）。
 */

/** 朝代 */
export interface Dynasty {
  id: string;
  name: string;
  startYear: number;
  endYear?: number;
  /** 关联的制度包 ID（data/institutions/<pack>/） */
  institutionPackId: string;
  meta: TemplateMeta;
}

/** 剧本：一次游戏的开局定义 */
export interface Scenario {
  id: string;
  name: string;
  dynastyId: string;
  /** 开局日期（公历 ISO 字符串；农历换算见需求 CONFLICT-001） */
  startGameDate: string;
  synopsis: string;
  /** 初始数据目录（相对仓库根） */
  initialDataRef: string;
  coreCharacterIds: string[];
  meta: TemplateMeta;
}

/** 人物四维能力（0-100） */
export interface CharacterAbilities {
  administration: number;
  military: number;
  intrigue: number;
  scholarship: number;
}

/**
 * 人物模板。
 * 人格/能力/目标为模板；忠诚/官职/生死为运行时（见 CharacterState）。
 * deathYear 记录历史结局，玩家行为可以改变（模板不被修改）。
 */
export interface Character {
  id: string;
  name: string;
  courtesyName?: string;
  birthYear?: number;
  deathYear?: number;
  factionId?: string;
  /** 人格特质（键为特质名，值 0-1） */
  personality: Record<string, number>;
  abilities: CharacterAbilities;
  /** 野心 0-100 */
  ambition: number;
  privateGoals: string[];
  /** 知识范围：信息不完全的边界，NPC 发言不得越界（FR-CHAR-002） */
  knowledgeScope: string[];
  meta: TemplateMeta;
}

/** 官职（模板） */
export interface Office {
  id: string;
  name: string;
  /** 品级 1-9（正一品至从九品） */
  grade: number;
  institutionId: string;
  powers: string[];
  /** 编制数 */
  quota: number;
  meta: TemplateMeta;
}

export type InstitutionType =
  | "decision" // 决策（内阁）
  | "administration" // 行政（六部）
  | "censorate" // 监察（都察院）
  | "military" // 军事
  | "fiscal" // 财政
  | "intelligence" // 情报（厂卫）
  | "palace" // 宫廷
  | "local"; // 地方行政

/** 机构/制度单元（制度包组成） */
export interface Institution {
  id: string;
  name: string;
  type: InstitutionType;
  parentId?: string;
  functions: string[];
  meta: TemplateMeta;
}

/** 制度包：朝代差异的数据表达，引擎加载后约束会议/任免/政策权限 */
export interface InstitutionPack {
  id: string;
  dynastyId: string;
  institutions: Institution[];
  offices: Office[];
  /** 中央决策结构说明（数据化细节随制度包扩展） */
  decisionStructure: string;
  meta: TemplateMeta;
}

/** 派系（模板部分；运行时见 FactionState） */
export interface Faction {
  id: string;
  name: string;
  ideology?: string;
  meta: TemplateMeta;
}

export type GameEventKind =
  | "historical_fixed"
  | "historical_conditional"
  | "dynamic"
  | "character"
  | "regional"
  | "disaster"
  | "war"
  | "court";

/** 事件触发条件：固定日期或条件 DSL 表达式（白名单求值，禁 eval） */
export interface EventTrigger {
  gameDate?: string;
  expression?: string;
}

/**
 * 事件模板。命名 GameEvent 以避免与 DOM 全局 Event 冲突。
 * effects 由规则引擎结算，LLM 只叙述已发生的事件。
 */
export interface GameEvent {
  id: string;
  kind: GameEventKind;
  trigger: EventTrigger;
  effects: Modifier[];
  /** 默认 false：每个事件只触发一次（FR-EVT-002） */
  repeatable?: boolean;
  meta: TemplateMeta;
}

/** 事件链（模板）：有分支的连续事件 */
export interface EventChain {
  id: string;
  name: string;
  steps: EventChainStep[];
  meta: TemplateMeta;
}

export interface EventChainStep {
  eventId: string;
  /** 分支映射：结果键 → 下一事件 id */
  branches?: Record<string, string>;
}
