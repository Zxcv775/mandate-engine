# ADR-023：政策生命周期模型

## 状态

已接受（2026-07-27，Phase 5）。

## 背景

政策需要一个可审计、可恢复、可回放的生命周期：从会议候选或直诏产生，经御批、
颁行、逐 tick 执行结算，到完成/失败/废止，每一步都是世界事实。

## 决策

- 11 态状态机：draft → proposed → approved → issued → implementing →
  (blocked | partially-implemented) → completed | failed | cancelled，外加
  suspended（皇帝主动暂停，区别于引擎自动 blocked）。`transitionPolicy` 纯函数 +
  14 事件完整转换矩阵（describe 导出）；终态不可复活（全矩阵测试）。
- 提示词状态清单未含 suspended 但要求 suspend/resume 命令——显式引入 suspended
  态而非复用 blocked，语义分离（谁暂停的、能否被资金自动解除）。
- reject 无独立终态：驳回归入 cancelled 并留 reason（避免第 12 个近义状态）。
- issue → issued（颁行待行），首次结算才 begin-implementation → implementing
  （"诏下而各衙门奉行自有时日"）；suspended 恢复时若从未结算回 issued，否则回
  implementing。
- 八个白名单命令 policy.propose/approve/reject/issue/adjust/suspend/resume/cancel
  全部经 StateEngine：Zod + 引擎双重校验、expectedRevision 乐观锁、幂等键、
  失败整体回滚、恰好 revision+1、StateChangeLog 主记录。policy.resolve-tick
  仅 Debug/测试（生产结算走 time.advance 同事务）。
- 直诏路径（§8.4）：无会议来源的 propose+approve 经 policy-legality 规则承担
  可计算代价（合法性扣减、阻力 Modifier、必要时 POLICY_LEGALITY_BLOCKED 直接拒批），
  数值全在 data/rules，不硬编码。
- 政治资本以 legitimacy 代理（Phase 5 简化）：politicalCost 记入
  legitimacyCostAccrued，废止时按其一半结算合法性代价。

## 状态写边界

LLM 不得创建/批准/推进/废止政策；会议候选须玩家"准行"并经白名单映射。

## 替代方案

单一 active/inactive 简化态：无法表达阻滞/部分推行/暂停的治理语义。

## 测试影响

tests/policy-lifecycle.test.ts：14 事件 × 11 态全矩阵 + 每命令
成功/失败/回滚/幂等/乐观锁/审计断言。

## 兼容性影响

Phase 0 六态经 state-002 前向迁移映射（executing→implementing、ended→completed）。
