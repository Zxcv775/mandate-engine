# ADR-022：规则 DSL 与效果白名单

## 状态

已接受（2026-07-27，Phase 5）。

## 背景

数据驱动规则（ADR-003）需要一种既可由内容作者书写、又不可能被 LLM 或恶意数据
借道执行任意逻辑的规则形态。Phase 0 的字符串表达式 condition（`"a.b >= 3"`）
无法在不写解析器/求值器的前提下安全落地，且事实上诱惑 eval。

## 决策

- 规则为纯 JSON（`data/rules`，RulePack v2，`dslVersion: 2`），Zod 深度校验；
  禁止内嵌代码、表达式字符串、eval / new Function（rule-engine 源码级测试守护）。
- conditions 为受限比较树：白名单路径（国家六项指标/资源、region(:id).stability|population、
  character(:id).favor|loyaltyToEmperor|stress|status|moralFlexibility|competence、
  policy.status|category|source|进度与资金字段、flags._）×
  `eq/ne/gt/gte/lt/lte/in/and/or/not`，树深 ≤ 5（Schema superRefine + 解释器双重拦截）；
  hidden._ 一律 `RULE_CONDITION_PATH_FORBIDDEN`（防规则数据成为泄露通道）。
- effects 只允许八种白名单动作（adjust-country-resource / adjust-country-metric /
  adjust-region-metric / adjust-character-metric / add-modifier / remove-modifier /
  advance-policy-progress / set-policy-blocked / queue-event-candidate）；
  超出者 `RULE_EFFECT_UNSUPPORTED` 拒绝加载；进度/阻滞类效果仅允许出现在
  政策结算上下文（防旁路写进度）。
- 求值顺序稳定：priority 降序，同分 ruleId 字典序；每条规则命中与效果数入 RuleTrace。
- 规则加载走注册表 + Manifest（跨包 id 去重、fnv1a 校验和、Snapshot 断言），
  Debug API 可查。

## 状态写边界

规则引擎输出候选 Mutation；一切落账仍经 StateEngine 白名单命令事务。

## 替代方案

表达式字符串 + 自研解析器：面积大且易被绕过；JS 沙箱：违反红线。

## 后果与风险

表达能力受限（无算术表达式）——复杂公式进入引擎代码而非数据；Phase 6+ 若需要
可对白名单扩展"有界算术节点"。

## 测试影响

Schema 合法/非法样例、深度炸弹、路径白名单、求值顺序、trace 完整性、
Manifest Snapshot、依赖矩阵与源码红线扫描（tests/rule-engine.test.ts、
tests/policy-schema.test.ts）。

## 兼容性影响

`baseline-modifiers.json` 迁移为 v2；旧格式不再被接受（data/ 内无其他旧规则文件）。
