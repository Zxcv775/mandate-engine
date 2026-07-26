# ADR-009：确定性状态引擎、RNG 与 Clock

## 状态

已接受（2026-07-26，Phase 2）。

## 背景

相同初始状态和命令序列必须得到相同 state hash，才能可靠 replay、校验存档和复现问题。系统时间与
`Math.random()` 会让结果随运行环境变化。

## 决策

- 所有世界状态写入仅经过 `StateEngine.applyCommand()` 或受控的 `applyRollback()`。
- Command 使用白名单 Zod discriminated union，携带 baseRevision、actor、createdAt 与可选 idempotencyKey。
- 引擎先生成 immutable Mutation Plan，校验 before/path，应用到副本，再用 GameState Schema 验证 next state。
- RNG 使用可注入 `RandomSource`，存档持久化 seed 摘要与 cursor；原始 seed 先做 SHA-256，避免凭据误入存档。
- 时间使用可注入 `Clock`；测试使用 `FixedClock`。核心状态路径禁止 `Math.random()`。
- state hash 和日志 hash 使用递归 key 排序的 stable JSON + SHA-256。

## 选择理由

显式 seed/cursor 与 Clock 消除了常见隐式输入；Mutation Plan 同时提供审计、inverse 和事务前 Schema 校验，
使纯引擎可独立于 SQLite、Fastify 和 LLM 测试。

## 替代方案

- 全局 `Math.random()`：不可重放。
- 只存 seed 不存 cursor：从中途 snapshot 恢复时无法定位随机序列。
- 直接在对象上修改：失败后难以保证原状态未污染。
- 直接使用系统时间：快照 hash 与测试结果不稳定。

## 缺点

所有随机和时间依赖都必须显式传递；稳定序列化和全状态 Schema 校验有额外 CPU 成本；RNG 算法升级需要兼容策略。

## 风险

遗漏一个隐式随机源、改变 stable JSON 或 RNG 算法都会导致旧日志不能确定性重放；cursor 上限为 32 位。

## 回退方案

引擎版本和 stateVersion 随存档保留；算法变化通过新版本迁移或保留旧 replay 实现，不原地改变旧序列。

## 对测试的影响

固定 seed/Clock 测试覆盖 cursor 恢复、同命令序列相同 hash、mutation/inverse、revision conflict、幂等与
snapshot + log replay。`test:determinism` 在 CI 中独立阻断。

## 对兼容性的影响

seed 摘要、cursor、stable serialization 与 RNG 算法成为存档协议的一部分；任何变更必须提升版本并提供迁移/兼容读取。
