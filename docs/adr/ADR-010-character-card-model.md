# ADR-010：分层人物卡模型

## 状态

已接受（2026-07-26，Phase 3）。

## 背景

Phase 0-2 的 `CharacterSchema` 只有自由 record 人格与 4 维能力，无法支撑受人格、利益、
场合与知识约束的 Character Agent。需要一个统一、严格、可扩展的人物模板，且必须与
既有 data-loader / initial-state 兼容，不得出现平行模型。

## 决策

- 人物模板重构为分层结构：`identity / historicalProfile / personality / politicalProfile /
  competence / communication / behaviorRules / initialRelations / knowledgeProfile / meta`
  （`packages/domain/src/character-template.ts`，全部 strict Zod）。
- 数值维度统一 0-100 整数；关系强度 -100..100。
- 三层分离：历史模板（data/ 只读）≠ 运行状态（GameState.characters）≠ 人物记忆（独立仓储）。
  Phase 3 不修改 `CharacterRuntimeState` Schema，避免 stateVersion 迁移；
  开局差异经模板 `identity.initialOfficeId` / `identity.initialRuntimeStatus` 在实例化时落入运行态。
- 原地演进而非并行模型：`templates.ts` 的 `CharacterSchema`/`Character` 成为
  `CharacterTemplateSchema`/`CharacterTemplate` 的别名。
- 数据策略（data-loader 强制）：人物卡含游戏建模数值，整卡 `meta.confirmation` 必须为
  `gameplay-adjusted`；majorExperiences 逐条带 `sourceIds` 与四类确认状态；争议评价只能进
  `disputedClaims` 或标 `disputed`。

## 选择理由

分层字段让 Prompt Composer 可以按维度渲染、按场合取舍；数值 + 文字双轨使行为可计算又可解释；
别名式演进保证仓库内单一人物模型，改动面收敛在 1 个数据文件与少量引用点。

## 替代方案

- 新建 CharacterTemplateV2 与旧 Schema 并存：产生平行模型，违反本阶段约束。
- 人格只用自由文本：不可计算、不可测试、无法约束一致性。
- 把开局官职/状态写进 GameState Schema：迫使 stateVersion 迁移，收益不成比例。

## 后果

- data/characters 全部重写为新格式（首批 5 人）；旧字段（abilities/privateGoals 等）废除。
- 依赖点同步更新：data-loader 校验器、scenario-loader 派系收集、initial-state 官职落位。

## 风险

- 首批人物数值为工程标定（gameplay-adjusted），文字表述仍需史料复核（Phase 7）。
- 层级较深，人工编写数据成本升高——由 `check:characters` 与引用校验兜底。

## 回退方案

恢复 `templates.ts` 中旧 CharacterSchema 定义并还原 5 个数据文件即可整体回退；
运行态与存档不受影响（未改 GameState Schema）。

## 测试影响

新增 `tests/character-schema.test.ts`（17 用例：范围/确认状态/来源/未知字段/时点约束）；
`data-schemas` / `state-engine` fixture 更新为新模板。

## 兼容性影响

GameState Schema 未变，既有存档无须迁移；`Character` 类型别名保持包间 API 兼容。
