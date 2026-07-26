# 03 · 领域模型

## 0. 总则

### 0.1 历史模板 vs 运行状态

- **模板（Template）**：只读，存于 `data/`，纳入 git 版本控制，必须携带史料来源标注
  （`meta.sourceIds` + `meta.confirmation`）。运行时**禁止**修改（FR-HIST-002）。
- **运行时（Runtime）**：可修改实例，存于 SQLite 存档；初始值由模板实例化而来，
  之后与模板脱钩（玩家可以改变历史）。
- 标注为"两者"的实体：定义部分为模板，实例部分为运行时。

### 0.2 LLM 可写性

- 默认：**所有实体的字段都不允许 LLM 直接写入**；
- LLM 只能产出：发言/奏折/叙事的**文本**、政策**草案**、记忆**摘要**——
  这些内容经 Schema 校验后，由系统（应用服务/规则引擎）决定如何落入状态；
- 数值字段（国库、忠诚、兵力、态度……）永远由规则引擎写入。

### 0.3 字段说明约定

下文"主要字段"与 `packages/domain/src` 中的类型定义保持一致；代码为准，本文档为解释。
`gameDate` 为游戏内日期（公历 ISO 字符串，农历换算见需求文档 CONFLICT-001）。

---

## 1. 实体定义

### Dynasty（朝代）

- 用途：一个可玩的朝代，关联其制度包。
- 主要字段：`id`、`name`、`startYear`、`endYear?`、`institutionPackId`、`meta`。
- 关系：1—n Scenario；1—1 InstitutionPack（制度包数据）。
- 归属：**模板**。LLM 可写：否。

### Scenario（剧本）

- 用途：一次游戏的开局定义（如"崇祯初政"）。
- 主要字段：`id`、`name`、`dynastyId`、`startGameDate`、`synopsis`、`initialDataRef`（初始数据目录）、`coreCharacterIds`、`meta`。
- 关系：属于一个 Dynasty；引用一组 Character 模板；实例化出 GameSession。
- 归属：**模板**。LLM 可写：否。

### Country（国家）

- 用途：玩家所统治国家的总体状态。
- 主要字段：`id`、`name`、`dynastyId`、`rulerCharacterId`、`treasury`（国库银两）、`grainReserves`、`stability`、`prestige`、`corruptionIndex`、`adminEfficiency`。
- 关系：聚合 Region、Army、Policy；由规则引擎结算。
- 归属：**运行时**（初始值来自 Scenario 数据）。LLM 可写：否。

### Region（地区）

- 用途：省级行政/地理单元的状态。
- 主要字段：`id`、`name`、`population`、`agriculture`、`commerce`、`taxBase`、`publicOrder`、`garrisonStrength`、`disasterRisk`、`controlLevel`（中央控制度）。
- 关系：属于 Country；政策与灾害的作用目标；Army 驻扎地。
- 归属：**运行时**（地理与基线数据来自模板）。LLM 可写：否。

### Character（人物）

- 用途：历史人物模板（Phase 3 起为分层人物卡，见 ADR-010）。
- 主要字段（模板 `CharacterTemplate`）：`id`、`name`、`identity`（字号/生卒/籍贯/历史官职/
  开局官职与状态）、`historicalProfile`（简介 + 逐条带 sourceIds 与四类确认状态的经历 +
  disputedClaims）、`personality`（10 维 0-100 + values/fears/desires/taboos/selfImage/worldview）、
  `politicalProfile`（派系/效忠/政敌/公开主张/私下利益/底线）、`competence`（8 维 0-100）、
  `communication`（语体刻度 + 自称 + 禁语 + 风格示例）、`behaviorRules`（场合行为倾向）、
  `initialRelations`、`knowledgeProfile`（领域访问级别/渠道/偏见/盲区）、`meta`
  （整卡必须 `gameplay-adjusted`：数值为游戏建模，非史料测量）。
- 运行时对应（Phase 2 实际 Schema，未变）：`CharacterRuntimeState { characterId, status,
officeId, favor, loyaltyToEmperor, stress, lastUpdatedRevision, sourceIds }`。
- 记忆对应（Phase 3，独立于 GameState）：`CharacterMemory`（来源 revision/类型/可信度/
  重要度/可见性/状态），存 SQLite `character_memories`，见 ADR-012。
- 视图对应：`CharacterStateView`（角色有限知识视图，逐条认知标注），见 ADR-011。
- 关系：担任 Office；属于 Faction；参与 Meeting；撰写 Memorial；持有 Relationship。
- 归属：**三层**（模板 / 运行态 / 记忆）。LLM 可写：否（LLM 只产出发言、候选行动与记忆候选）。

### Office（官职）

- 用途：官僚体系中的职位定义。
- 主要字段：`id`、`name`、`grade`（品级 1–9）、`institutionId`、`powers`、`quota`（编制数）、`meta`。
- 运行时对应：`OfficeHolder { officeId, characterId, appointedAtGameDate }`。
- 关系：属于 Institution；由 Character 担任。
- 归属：**两者**。LLM 可写：否。

### Institution（机构/制度单元）

- 用途：制度包的组成单元（内阁、六部、都察院、锦衣卫、东厂……）。
- 主要字段：`id`、`name`、`type`（decision / administration / censorate / military / fiscal / intelligence / palace / local）、`parentId?`、`functions`、`meta`。
- 关系：树形结构；下辖 Office；产生 IntelligenceReport。
- 归属：**模板**。LLM 可写：否。

### Faction（派系）

- 用途：政治集团（如阉党、东林）。
- 主要字段（模板）：`id`、`name`、`ideology?`、`meta`；
  运行时 `FactionState { factionId, influence, cohesion, memberIds }`。
- 关系：Character 归属；影响会议表态与政策阻力。
- 归属：**两者**。LLM 可写：否。

### Relationship（关系）

- 用途：人物间关系（信任/敌对/亲属/师生/同盟）。
- 主要字段：`fromCharacterId`、`toCharacterId`、`kind`、`strength`（-100..100）、`hidden`（是否对玩家未知）。
- 关系：连接两个 Character。
- 归属：**运行时**。LLM 可写：否。

### Meeting（会议）

- 用途：一次朝会/御前会议/秘密议事的实例，携带**规则环境快照**。
- 主要字段：`id`、`type`、`gameDate`、`topic`、`rules`（MeetingRules 快照：人数上限/公开性/记录/泄密概率/合法性修正/坦率基准/政治风险）、`participants`、`status`、`transcriptMemoryId?`。
- 关系：包含 MeetingParticipant；产出 Memory（正式记录）与可能的泄密 Event。
- 归属：**运行时**。LLM 可写：否（LLM 生成发言内容，不操作会议实体）。

### MeetingParticipant（会议参与者）

- 用途：记录某人物在某会议中的角色与表现。
- 主要字段：`characterId`、`role`（chair / participant / observer）、`hasSpoken`、`stance?`。
- 关系：属于 Meeting；指向 Character。
- 归属：**运行时**。LLM 可写：否。

### Memorial（奏折）

- 用途：臣子上呈的文书，玩家主要的信息来源与决策入口。
- 主要字段：`id`、`authorCharacterId`、`gameDate`、`title`、`content`、`category`、`truthfulness`（0–1，隐藏）、`status`（unread / read / retained 留中 / responded）、`imperialResponse?`、`requiresDecision`。
- 关系：作者为 Character；可触发 Policy 或 Event。
- 归属：**运行时**。LLM 可写：**仅限 content/title 文本**（经系统落入实体，状态字段由系统管理）。

### IntelligenceReport（情报报告）

- 用途：厂卫/密折等渠道的情报，可能更准确也可能被操纵。
- 主要字段：`id`、`sourceInstitutionId`、`gameDate`、`content`、`accuracy`（0–1，隐藏）、`scope`。
- 关系：由 Institution 产生；可揭露 hidden 信息。
- 归属：**运行时**。LLM 可写：仅限文本。

### Policy（政策）

- 用途：玩家决策的结构化载体，规则结算的输入。
- 主要字段：`id`、`name`、`description`、`status`（draft / issued / executing / suspended / repealed）、`targetRegionIds`（或 "all"）、`modifiers`、`legitimacyCost`、`executionResistance`、`issuedAtGameDate?`。
- 关系：由 ImperialDecree 颁布；产生 Modifier 作用于状态；在会议中获得合法性修正。
- 归属：**运行时**。LLM 可写：**仅限草案**（draft，须经制度校验与玩家裁决）。

### ImperialDecree（圣旨/诏令）

- 用途：皇帝意志的正式表达，政策颁布与人事任免的载体。
- 主要字段：`id`、`gameDate`、`content`、`relatedPolicyId?`、`addressee`、`status`（drafted / issued / executed / resisted）。
- 关系：可关联 Policy；执行结果由规则引擎判定（可能"resisted"被抵制）。
- 归属：**运行时**。LLM 可写：仅限文本润色。

### Event（事件）

- 用途：改变局面的事态（历史固定/历史条件/动态/人物/地区/灾害/战争/宫廷）。
- 主要字段（模板 `GameEvent`）：`id`、`kind`、`trigger`（`expression` 条件 DSL 或固定 `gameDate`）、`effects`（Modifier 列表）、`meta`；
  运行时：`GameState.firedEventIds` 记录已触发。
- 关系：可属于 EventChain；效果经规则引擎结算。
- 归属：**两者**。LLM 可写：否（LLM 只叙述已发生的事件）。

### EventChain（事件链）

- 用途：有分支的连续事件（如"阉党倒台"链条）。
- 主要字段：`id`、`name`、`steps`（eventId + 分支映射）、`meta`。
- 关系：组织多个 Event。
- 归属：**模板**。LLM 可写：否。

### Army（军队）

- 用途：一支可作战力量的状态。
- 主要字段：`id`、`name`、`regionId`、`size`、`morale`、`supply`、`payArrearsMonths`（欠饷月数）、`commanderCharacterId?`。
- 关系：驻扎 Region；参与 War；欠饷影响 morale（规则）。
- 归属：**运行时**。LLM 可写：否。

### War（战争）

- 用途：一场持续军事冲突的总体状态。
- 主要字段：`id`、`name`、`belligerentFactionIds`、`frontRegionIds`、`status`（active / truce / ended）、`startedAtGameDate`。
- 关系：涉及 Army 与 Region；MVP 为简化推演（回合结算，非即时战术）。
- 归属：**运行时**。LLM 可写：否。

### Resource（资源）

- 用途：标准化资源表达（银两/粮草/人口/人力/威望）。
- 主要字段：`type`、`amount`、`unit`。
- 关系：嵌入 Country/Region/Event 效果中使用。
- 归属：值对象（随宿主归属）。LLM 可写：否。

### Modifier（修正器）

- 用途：**数据驱动规则的核心**——一切数值影响的统一表达。
- 主要字段：`id`、`sourceId`（政策/人物/制度/事件）、`targetPath`（状态路径）、`operation`（add / multiply / set）、`value`、`durationTurns?`、`condition?`（白名单 DSL）、`reason?`。
- 关系：由 Policy/Event/Institution 产生；由规则引擎合成与结算（FR-RULE-003）。
- 归属：**运行时**。LLM 可写：否（草案中的 Modifier 须经规则引擎换算确认）。

### Memory（记忆）

- 用途：人物/会议/叙事的记忆条目，支撑上下文与长期一致性。
- 主要字段：`id`、`ownerId`（characterId / player / narrator）、`kind`（short_term / long_term / meeting_record）、`content`、`importance`、`createdAtGameDate`。
- 关系：被 Character 持有；Meeting 产生 meeting_record。
- 归属：**运行时**。LLM 可写：**仅限 content 摘要文本**（由 Memory Manager 写入）。

### HistoricalSource（史料来源）

- 用途：所有历史模板数据的来源绑定（见"历史真实性"约束）。
- 主要字段：`id`、`title`、`author?`、`sourceType`（primary / academic / reference / inference）、`citation?`、`url?`、`accessedAt?`、`reliability`（high / medium / low / disputed）、`notes?`。
- 关系：被一切模板数据经 `meta.sourceIds` 引用。
- 归属：**模板**（`data/historical-sources/`）。LLM 可写：否（可建议条目，须人工/校验确认）。

### GameSession（游戏会话）

- 用途：一局游戏的元信息。
- 主要字段：`id`、`scenarioId`、`playerName?`、`rngSeed`（复现用）、`startedAtRealTime`、`settings{difficulty}`。
- 关系：1—1 GameState；1—n 存档槽位。
- 归属：**运行时**。LLM 可写：否。

### GameState（游戏状态 · 单一事实源）

- 用途：全部运行时状态的聚合根，**唯一可信来源**。
- 主要字段：`sessionId`、`currentGameDate`、`turn`、`country`、`regions[]`、`characters[]`（CharacterState）、`officeHolders[]`、`factions[]`、`relationships[]`、`policies[]`、`activeMeeting?`、`armies[]`、`wars[]`、`firedEventIds[]`、`hidden`（HiddenState：真实忠诚/阴谋值/泄密累积）。
- 关系：聚合一切运行时实体；存档快照的本体。
- 归属：**运行时**。LLM 可写：否（且 LLM 视图过滤 hidden）。

### StateChangeLog（状态变更日志）

- 用途：一切状态修改的审计记录，**只增不改**。
- 主要字段：`id`、`sessionId`、`realTimestamp`、`gameDate`、`turn`、`actor`（player / system / rule_engine）、`summary`、`changes[]`（path/before/after）、`ruleRefs[]`。
- 关系：引用 GameState 的变更；调试与回放基础。
- 归属：**运行时**（SQLite 持久化）。LLM 可写：否。

---

## 2. 实体—归属速查表

| 类别        | 实体                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯模板      | Dynasty、Scenario、Institution、EventChain、HistoricalSource                                                                                                                |
| 模板+运行时 | Character、Office、Faction、Event                                                                                                                                           |
| 纯运行时    | Country、Region、Relationship、Meeting、MeetingParticipant、Memorial、IntelligenceReport、Policy、ImperialDecree、Army、War、Memory、GameSession、GameState、StateChangeLog |
| 值对象      | Resource、Modifier（随宿主）                                                                                                                                                |

## 3. LLM 可写白名单（全集）

| 内容                    | 落入实体                                           | 校验与落地                   |
| ----------------------- | -------------------------------------------------- | ---------------------------- |
| 发言/奏折/情报/叙事文本 | Meeting 发言、Memorial、IntelligenceReport、Memory | Schema + 系统写入            |
| 政策草案                | Policy(status=draft)                               | Schema + 制度校验 + 玩家裁决 |
| 记忆摘要                | Memory.content                                     | Memory Manager 写入          |

除上表外，LLM 对任何实体字段均无写权限。

## 4. Phase 2 运行时聚合

`packages/domain/src/state.ts` 是实际 GameState Schema 的唯一来源。顶层包含：

- 版本与身份：`schemaVersion`、`stateVersion`、`saveId`、`scenarioId`、`dynastyId`；
- 顺序：`revision`、`tick`、ISO `currentDate`；
- 确定性：`rng.seed`（原始 seed 的 SHA-256）与 `rng.cursor`；
- 运行态：`country`、`characters`、`offices`、`policies`、`regions`、`meetings`、`eventQueue`、`flags`；
- 内部态：`hidden`；
- 审计元数据：`meta.createdAt/updatedAt/sourceIds/sourceCatalogPresent`。

国家资源使用非负安全整数；legitimacy/stability/administrativeCapacity/militaryReadiness 限制在 0..100。
人物状态、政策状态和会议状态均为 strict enum；运行态只保存模板 ID 与变化值，不复制历史传记。

## 5. Command 与 Mutation

Phase 2 Command 是 strict discriminated union：`game.create`、`country.adjust-resource`、
`character.assign-office`、`time.advance`、`checkpoint.create`、`save.rollback`。所有命令包含 saveId、
baseRevision、actor、createdAt，可选 idempotencyKey。未知 commandType 或字段会在应用状态前拒绝。

Mutation 记录 aggregate/entity、operation、JSON Pointer path、before/after、reason、sourceIds、visibility 和 tags。
Mutation Applier 只操作副本，拒绝不存在路径、before 不匹配和 `__proto__/prototype/constructor` 路径；完成后重新
通过 GameState Schema。inverse 由 before/after 与反向 operation 生成。

## 6. StateChangeLog 与 Save DTO

`StateChangeLogEntry` 按 `txId + revision + sequence` 分组，保存 actor/command、mutation、inverse、state hash、
prevLogHash 与 entryHash。visibility 为 public/internal/sealed；普通 API 永久过滤 sealed。

存档 DTO 包括 SaveMetadata、CheckpointMetadata、ExportManifest、ImportResult、ValidationReport 和 RepairPlan。
导出 manifest 明确记录 schema/state/export format version、lineage、revision、source metadata mode、加密与
safe-share 状态。

## 7. 只读状态视图

- `PlayerStateView`：GameState 去除 `hidden`，深拷贝后只读返回。
- `CharacterStateView`：仅公开国家摘要、角色自身、已知政策/会议和 sourceIds，不包含完整 hidden/sealed。
- `DebugStateView`：仅内部引擎与测试可构建，包含完整状态。

View 是派生 DTO，不是事实源；修改 View 不会反向修改 GameState。Phase 3 Agent 必须从这些视图读取，并通过
白名单 Command 提交候选动作。
