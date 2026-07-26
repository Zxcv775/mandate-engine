# 2026-07-26 · Phase 4 实施记录

## 基线（P4.0）

- PR #1（Phase 1-3，commit 7c3cb7e）经用户授权合并至 main（7d9574b）；主仓库工作树以
  stash→pull→diff 校验（零差异）→drop 安全落到合并后 HEAD；Phase 4 在
  `phase4/meeting-director` 分支按里程碑小步提交（用户预授权，push 待验收后统一执行）。
- 便携版 Node 24.18.0（含 npm 11.16.0，与 .nvmrc 组合一致）下载至
  `@work/tools/node-v24.18.0-win-x64`，全部 Phase 4 验证在其下运行；check:phase3
  复跑 275/275 全绿，benchmark 与 Node 25 差异在噪声范围。修复了 merge 后
  autocrlf checkout 导致的 ci.yml 行尾断言问题。
- 记忆随存档导入导出补齐：MEMORY_TABLES 复制（快进去重合并/fork 主键前缀重写/
  载荷 revision 校验），save-import-export 新增 5 个回归用例。

## 实施结果

- Domain：meeting-runtime/agent/api 全套 strict Zod（12 态、13 回合类型、12 种玩家动作、
  15 个状态机事件、结果候选、泄密评估、纪要、上下文预算）+ 19 个 MEETING_* 错误码。
- 命令：meeting.create/start/conclude/cancel 经 StateEngine 更新 GameState 最小投影
  （conclude 携带泄密候选事件 sealed 写入 hidden 队列）；applyMutation 获得 add/remove
  逐键语义（含 inverse 回滚测试）。
- meeting-engine 新包（零 LLM 依赖）：状态机全矩阵、13 项资格、确定性调度
  （SpeakerScoreBreakdown + SeededRng tie-break）、Director 决策树（七类上限）、
  白名单命令映射、确定性泄密评估、规则纪要与分化记忆生成。
- 存储：migration 003 七张 STRICT 表；MeetingRepository（meetingVersion 乐观锁、
  两阶段 commitAgentTurn、action_id/turn_number 双唯一幂等、可见性投影查询）；
  safe_share 剥离 sealed/private 会议内容；会议表随存档导入导出。
- Agent：3 个新 Prompt 资产（议程/Transcript/会议输出契约）、composer 会议段 +
  Transcript 预算、MeetingCharacterOutputSchema、output-repair 泛型化、
  respondInMeeting（referencedTurnIds ⊆ 可见回合的一致性硬校验）。
- 服务与 API：MeetingService 全编排（两阶段 + failed→paused→resume 恢复 +
  同 actionId 幂等）；12 公开 + 3 Debug 端点；Meeting Lab 页签。
- 测试：新增 6 个会议测试文件（state/scheduler/recovery/security/memory-leak/
  outcome+integration），含 §27 御前会议 5 人闭环、秘密议事闭环、跨进程重载恢复、
  safe_share 导出隔离、恶意输入矩阵；benchmark:phase4 实测（20 回合 Mock 会议
  6.1ms/回合、千回合 Transcript 写入与分页、5/10/20 人调度）。

## 验证状态

见 Phase 4 最终报告（会话输出）；check:phase4 全链在 Node 24.18.0 下真实退出码 0。

## 验收实测（浏览器 Meeting Lab）

- 闭环一（御前会议 5 人）在 Meeting Lab 全程实测：创建（袁崇焕资格排除）→ 议程 →
  开场 → 魏忠贤/崔呈秀轮替陈奏 → 点名垂询王承恩（player-question → character-answer）→
  5 个结果候选 → 仅建议候选"准行"被 422 MEETING_OUTCOME_UNSUPPORTED 拒绝（revision 不变）→
  结束 → 正式纪要（逐条 sourceTurnIds）→ 分化记忆（发言者含本人发言记忆，
  沉默者黄立极仅纪要记忆）→ revision 恰为 create/start/conclude 三次。
- 恢复实测（真实进程重启）：dev Mock 缺会议分支导致回合 failed + pendingAgentAction
  存留 → tsx 重启服务器进程 → failed→paused→resume → 同 actionId 恢复步进恰
  产生一条回合。乐观锁并发双击返回 MEETING_VERSION_STALE 409，UI 呈现错误不错乱。
- 闭环二（秘密议事）实测：仅王承恩与会 → 普通 Transcript API 零可见（0 条），
  Debug API 3 条（全 private）→ 泄密评估确定性 roll（score 7 / threshold 0.07 /
  roll 0.100087 未触发）→ 未参会者魏忠贤上下文零泄露（无标题/无 ID/无议程标记）。
- 实测发现并修复两缺陷（commit 5fbe526）：dev 默认 Mock 兜底不识别会议契约
  （必然 LLM_OUTPUT_REPAIR_FAILED）；Meeting Lab 暂停按钮未开放 failed 状态
  （恢复路径在 UI 不可达）。附 provider-factory 双模式回归测试。
- 已知缺口：meeting.cancel 命令未暴露 REST 端点（引擎/命令层已实现并有测试）；
  Meeting Lab 创建表单的复选框在程序化 form_input 下不更新 React 状态（真实点击正常）。

## 下一步边界

Phase 5 尚未开始。只能在人工评审后进入规则引擎、政策草案、政策执行阶段、资源消耗、
行政阻力与政策结算。
