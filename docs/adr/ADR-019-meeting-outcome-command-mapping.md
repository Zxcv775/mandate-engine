# ADR-019：结果候选到命令的白名单映射

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

会议讨论不能直接变成世界修改；LLM 提议与世界写入之间必须有确定性关卡。

## 决策

- LLM 只产出候选（标题/理由/风险/支持者/自然语言摘要）；service 从 proposedActions
  确定性构造候选：recommend-appointment + 存在的目标人物 → commandPreview
  （character.assign-office，含罢免 officeId=null）；其余类型一律 unsupportedCommand。
- mapOutcomeToCommand 白名单：Phase 4 仅 country.adjust-resource 与
  character.assign-office；Payload 经 strict Zod、目标实体存在性与资源余额预检；
  其余返回 MEETING_OUTCOME_UNSUPPORTED 保留为建议，绝不伪造命令、绝不 Patch 状态。
- 玩家裁决：接受的可映射候选 → GameCommand（actor system/meeting-director）→
  StateEngine.applyCommand → StateChangeLog；同议程未选候选置 rejected；
  重复裁决同议程 → MEETING_RULING_INVALID(409)。

## 状态写边界

只有此路径能把会议内容变成世界状态；StateEngine 仍是唯一写入口并二次校验。

## 替代方案

允许 LLM 返回 Mutation：一步绕过全部规则（明确禁止）。

## 一致性影响 / 恢复路径

裁决内多命令串行 baseRevision 链；失败即抛出，已提交命令保持（append-only），
候选状态未更则可重试幂等（accepted 检查拒绝重复接受）。

## 安全影响

恶意 commandPreview（任意路径/未知命令/超额资源）全部在映射层拒绝，测试覆盖。

## 回退方案

白名单清空即回到"纯建议"模式。

## 测试影响

tests/meeting-outcome.test.ts：映射矩阵 + 裁决 API（空裁决零变更/重复 409/stale 409）。

## 后续升级

Phase 5 政策引擎接入时向白名单增加 policy.* 命令即可。
