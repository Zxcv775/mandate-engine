# 2026-07-27 · Phase 5 实施记录

## 基线（P5.0）

- phase4/meeting-director 经 PR #2 授权合并至 main（e0f64aa）；合并后 main 在
  Node 24.18.0 下全链 battery 全绿（ci/lint/typecheck/346 测试/build/check:data/
  check:phase2/3/4 全部退出码 0）；从 main 切 `phase5/policy-engine` 开发。
- P5.0 遗留收尾：meeting.cancel REST 端点（会话侧先验证转换合法再提交世界命令）+
  Lab"取消会议"按钮 + 5 用例；复选框核实本为标准受控写法（Phase 4 报告猜测不成立，
  实为浏览器自动化事件派发限制），补稳定 id/htmlFor 与 store 单测。
- 子代理/Workflow 仍全部不可用（deepseek-v4-flash 路由故障，本会话再次探测确认），
  全部工作由主线完成。

## 实施结果（里程碑提交 M0~M4）

- M1 领域：policy.ts（模板全字段 + 11 态运行态 + PolicyTruth）/modifier.ts/
  rule-dsl.ts（受限条件树 + 8 白名单 effect + 深度上限）/policy-api.ts；
  15 个错误码；8+1 个 policy.* 命令；GameState 加 modifiers 与 hidden.policyTruth
  （GAME_STATE_VERSION=2，state-002 前向迁移 + 测试）；data-loader 装载
  data/policies（引用闭环 + sourceIds≥2 + gameplay-adjusted 强制）；
  baseline-modifiers.json 迁移 v2 DSL。
- M2 引擎：rule-engine 落地（Modifier 合成/条件求值/解释器/效果规划/合法性/注册表，
  源码级红线守护）；game-engine policy-commands（transitionPolicy 14 事件全矩阵 +
  8 planner）；StateEngine.applyCommand 增 policyAssets 上下文；
  rollback fields 补 modifiers；fnv1a 下沉 shared。
- M3 结算：rule-engine resolution（系数十项分解 + 六类偏差 + 奏报文言）；
  game-engine policy-resolution（草稿态推进编排、断供 blocked、阶段完成按
  真实/奏报折扣、完成/失败终局与长期 Modifier）；time.advance 同事务挂接
  （elapsedTicks 线性缩放）+ policy.resolve-tick（Debug）；migration 004 三表 +
  PolicyDetailRepository（同事务 extraWrites；回滚重推确定性覆盖）；
  importer/safe_share 对齐；mapper 加 policy.propose；mock 荐策标记。
- M4 数据与界面：9 个崇祯初政政策模板（钦定逆案/拆生祠/起复诸臣/发内帑济辽饷/
  清查京营/核查冒饷/蠲免逋赋/赈济陕西/驿递整顿【时序争议已标注】）+
  合法性崩坏阻断规则；政策 API（10 公开 + 3 Debug）+ PolicyService + 错误映射
  404/409/422；Policy Lab 第四页签（直诏/御批/颁行/调整/暂停/复行/废止/推进时间/
  奏报流/Debug 真实对比）；policy-security（8）与 phase5-integration（7，双闭环）
  测试；benchmark:phase5；check:phase5 脚本链与 CI 步骤；版本 0.5.0；
  ADR-022~026 与 docs/09。

## 性能修正（基准驱动）

benchmark 首跑暴露 applyMutations 每条 mutation 全量克隆状态（O(mutations×stateSize)）：
20 政策 × 120 tick 长程推进 1731ms/tick。修复为整批单次克隆 + 草稿原地应用后
342ms/tick（5×），单政策单 tick 1.42ms（目标 <1ms，剩余成本在全量 Zod 双 parse
与哈希链，Phase 12 优化；已记入 docs/09 已知边界）。

## 验证状态

见 Phase 5 最终报告（会话输出）；check:phase5 全链在 Node 24.18.0 下真实退出码 0。
