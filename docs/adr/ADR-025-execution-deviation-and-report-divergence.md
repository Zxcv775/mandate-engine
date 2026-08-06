# ADR-025：执行偏差与奏报失真

## 状态

已接受（2026-07-27，Phase 5）。

## 背景

"上有政策，下有对策"是本作核心体验：玩家读到的是官僚系统的奏报，而非上帝视角。
真实执行与奏报必须结构性分离，且全部由确定性规则驱动。

## 决策

- 双层真实性：政策运行态的 stageProgress/overallProgress 是**奏报口径**（玩家可见）；
  真实进度/腐败累计/偏差摘要存 `GameState.hidden.policyTruth`（仅 Debug API，
  safe_share 随 hidden 清空）。明细三表（migration 004：policy_stage_results /
  policy_reports / policy_deviation_log）与状态变更同事务落库（commitTransition
  extraWrites），safe_share 剥离偏差流水、结算明细与内档奏报（公开奏报保留）。
- 六类偏差（delay / surface-compliance / falsified-figures / overzealous-execution /
  selective-execution / corruption-loss）：每 tick 按类型独立 roll，概率 =
  base + moralFlexibility×w1 − loyalty×w2（`DEFAULT_POLICY_DEVIATION_CONFIG`，
  可注入配置）；效果各自产生真实修正 + 奏报失真 + 留痕（deviation_log 带
  discovered 标记，供后续核查玩法消费）。
- 人物卡无 moralFlexibility 字段：以 100 − integrity 换算（装配层计算）。
- 执行系数（0..1）十项分解（行政能力含 Modifier/负责人能力·忠诚·压力/难度/
  合法性/资金到位率/阻力/效率乘子/扰动）全量入 policy_stage_results.breakdown，
  Debug API 可查。
- 阶段完成时效果按 真实/奏报 比例折扣（下限 0.3）——表面完成的政策效果打折，
  隐患留在真实口径。
- 奏报为结构化数据 + 模板文言（renderReportText）；LLM 叙事化属后续阶段。

## 状态写边界

结算只在 time.advance / policy.resolve-tick（Debug）事务内；hidden 真实值
不进入任何角色视图与规则条件。

## 替代方案

LLM 决定偏差：不可复现（禁止）；单一真实进度：失去信息不对称玩法。

## 测试影响

偏差确定性触发与重放一致、奏报/真实分离断言、safe_share 剥离、
玩家 API 无 realStageProgress 泄露（tests/policy-resolution.test.ts、
tests/policy-security.test.ts、tests/phase5-integration.test.ts）。
