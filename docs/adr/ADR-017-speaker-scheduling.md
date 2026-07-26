# ADR-017：确定性发言调度

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

发言顺序必须可解释、可复现，且不得用 Math.random。

## 决策

- 资格 13 项确定性检查（存在/active/参会/在场/silenced/observer/by-permission/
  议题官职/上限/pending/知识访问），皇帝点名豁免受限项。
- 评分明细 SpeakerScoreBreakdown 全字段：点名 +100、议题相关 ≤30、官职责任 +25、
  请求发言 +20、被质疑 +15、立场多样性 ≤15、紧迫度 ≤10；近发言 -25、
  发言次数 ×4、沉默倾向 -8、信息受限 -10。
- 同分 tie-break：SeededRng(fnv1a(saveId:meetingId)+turnNumber)——种子派生自存档与
  会议标识，cursor 用回合号推进，不触碰 GameState rng cursor。

## 状态写边界

纯函数，无写。

## 替代方案

- 轮询制：无法表达点名/专业/质疑语义。
- 触碰世界 RNG cursor：会让会议观测行为改变世界重放序列。

## 一致性影响 / 恢复路径

同输入同输出；恢复后重算得到同一排序。

## 安全影响

评分输入全部来自确定性状态，LLM 输出仅通过 requestsToSpeakAgain 影响"请求发言"位。

## 回退方案

可退化为"仅点名"模式（emperorSelected 唯一得分项）。

## 测试影响

tests/meeting-scheduler.test.ts §21.3 九项 + 同分确定性复跑。

## 后续升级

立场多样性可由 turns privateMetadata 统计喂入，无接口变化。
