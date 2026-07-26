# ADR-024：统一 Modifier 系统

## 状态

已接受（2026-07-27，Phase 5）。

## 决策

- 运行态 Modifier 是世界事实：存 `GameState.modifiers`（record，随快照/回放/回滚走；
  applyRollback fields 白名单已纳入），一切产生/清除经白名单命令或规则 effect 的
  候选 Mutation。
- 结构：target 判别 union（country / region:id / character:id / policy:id）×
  指标白名单（MODIFIER_METRIC_WHITELIST，Schema superRefine 强制）×
  操作（add / mul / clamp-min / clamp-max）× 时效（effectiveTick、expiresAtTick|null）
  × 叠加语义（stack / unique-by-source / replace）。
- 政策虚拟指标 executionEfficiency（基准 1）与 resistance（基准 0）无存储字段，
  仅在结算内经 `resolveEffectiveValue` 合成。
- 应用顺序确定：add（modifierId 字典序）→ mul → clamp-min → clamp-max；
  unique-by-source 同源同操作取 id 最小；replace 取 effectiveTick 最大
  （同 tick 取 id 最大，后写覆盖）——全部有测试锁定。
- 过期清理在时间推进事务内（`planExpiredModifierCleanup`）产出 remove mutation
  留痕，StateChangeLog 可见。
- `resolveEffectiveValue(state, target, metric, tick)` 是全引擎唯一有效值入口，
  返回值同时携带 applied 步骤明细（可审计）。

## 替代方案

targetPath 字符串（Phase 0 形态）：无法静态校验目标类型与指标白名单。

## 测试影响

叠加序/时效窗口/白名单拒绝/过期留痕（tests/rule-engine.test.ts）；
政策阻力与效率 Modifier 在合法性与结算链路的端到端断言。

## 兼容性影响

GameState 新增 modifiers 字段，state-002 迁移初始化为 {}。
