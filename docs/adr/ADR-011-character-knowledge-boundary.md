# ADR-011：角色知识边界与有限视图

## 状态

已接受（2026-07-26，Phase 3）。

## 背景

Phase 2 的 `toCharacterStateView` 只是占位：暴露全部 policies/meetings，没有知识过滤。
Character Agent 不得读取完整 GameState，也不得因为信息存在于状态中就默认角色知道；
必须区分事实 / 听闻 / 推测 / 过时 / 错误认知。

## 决策

- 六级可见性口径：`public / court / office / meeting / private / sealed`。
- 视图构建位于 agent-runtime 纯函数层（`visibility-policy.ts` + `character-view-builder.ts`），
  不在 React 前端，不在路由。
- 每条信息输出为 `CharacterKnowledgeItem`：value + KnowledgeStatus（known/reported/suspected/
  inferred/outdated/contradicted）+ confidence + sourceType + sourceIds。
- 裁决维度：领域访问级别 = max(人物卡 accessLevels, 在任机构加成, active 朝局体感下限)，
  非在朝者封顶 limited 且数值粗化、标 outdated；会议按 participantIds 过滤
  （朝会公开；御前会议对外仅传闻且不泄名单；秘密议事/单独召见对非参与者连存在都不可见）；
  他人运行态只暴露公开事实（status/officeId），favor/loyalty/stress/私密目标绝不出视图。
- `state.hidden` 与 `state.flags` 在构建器中完全不读取；输出经
  `CharacterStateViewSchema`(strict) 校验，多余字段直接失败。
- 旧视图更名 `BasicCharacterStateView` 并弃用。

## 选择理由

逐条裁决 + 认知标注让"角色不知道所有事实"成为可测试性质而非口头承诺；
纯函数 + strict Schema 把泄露风险变成构建期错误。

## 替代方案

- `removeHidden(state)`：只挡了 hidden，一样把他人私密与未参与会议全量泄露（明确禁止）。
- 在 Prompt 层过滤：太晚，调试视图与 API 仍会泄露。

## 后果

视图是有损投影：Agent 拿到的是粗化/滞后/带疑的世情，输出 claims 须自报 basis。

## 风险

规则表是启发式的（如粗化粒度、体感下限），后续场景可能需要按官职细化——集中在
`visibility-policy.ts` 一处，便于演进。

## 回退方案

保留的 `BasicCharacterStateView` 可作应急降级；删除 agent-runtime 视图层不影响 Phase 2 功能。

## 测试影响

`tests/character-view.test.ts` 15 用例：官职增益、会议过滤、hidden/sealed 序列化断言、
谣言粗化、错误认知不纠正、Debug 与普通视图区分、确定性。

## 兼容性影响

纯新增；Phase 2 的 Player/Debug 视图不变。
