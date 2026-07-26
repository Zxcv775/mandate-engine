# ADR-026：政策结算随机数策略

## 状态

已接受（2026-07-27，Phase 5）。

## 背景

政策结算的扰动与偏差 roll 需要受控随机。两个候选：
a) 世界 RNG（GameState.rng cursor 在事务内推进）；
b) 派生流（fnv1a 派生种子，不动世界 cursor，Phase 4 调度/泄密模式）。

## 决策

采用 **b) 派生流**：每政策每次结算使用
`seed = "policy:{saveId}:{policyId}:{fnv1a(saveId:policyId)}"`、
`cursor = tick × 32` 的确定性随机源（每 tick 预留 32 个 roll 空间，跨 tick 不重叠）。

理由：

1. 政策间互不干扰：增删某个政策不改变其他政策的随机序列，黄金样本与
   逐政策测试稳定；
2. 结算顺序无关：虽然实现按 policyId 字典序迭代，随机性不依赖该顺序；
3. 世界 cursor 保持为事件抽取（Phase 6）保留的稀缺资源，避免政策高频结算
   使 cursor 高速膨胀、放大回放偏移面；
4. 与 Phase 4（调度 tie-break、泄密 roll）同构，团队心智单一。

代价：rng.cursor 不再记录政策随机消耗——以 RuleTrace / deviation_log 记录每次
roll 与概率补足审计。

## 确定性保证

同一存档同一 seed 重放逐 tick 一致；回滚后重推结果一致（世界 cursor 不被扰动，
派生流仅依赖 saveId/policyId/tick）——两者均有测试断言
（tests/policy-resolution.test.ts）。

## 替代方案

世界 RNG：审计集中于 cursor，但引入政策集合敏感性（增删政策改变后续所有 roll）
与顺序耦合，回放脆弱。

## 兼容性影响

无状态结构变化；Phase 6 事件引擎可独立选择世界 RNG 而互不影响。
