# 2026-07-28 · Phase 2–5 代码审查修复

## 范围

- 修复 REVIEW-001 至 REVIEW-013；不进入 Phase 6。
- 保留 append-only 审计历史；新增当前时间线投影、共享事务、幂等请求哈希与政策成本账本。
- 加固 Agent 陈旧响应、safe-share、ZIP 导入、政策责任校验、Modifier 来源比较和 no-op 防线。

## 数据库

- migration 005：`save_rollback_events`、`command_transactions.request_hash`，政策阶段结果按 revision 唯一。
- migration 006：`policy_cost_applications` 追加式成本应用记录。
- migration 007：`meeting_rulings` 裁决级请求指纹与重放结果。
- 导入器对旧数据库缺失的新表/新列采用跳过/补空值，维持前向导入路径。

## 验证

- 专项入口：`npm run check:review-fixes`。
- 全量入口：`npm run check:phase5`。
- 全量 Vitest：52 个测试文件、459 个用例通过。
- 最终各命令结果以本次会话交付报告为准。

## 第二轮聚焦修复

- 新增 migration 008，把会议 session 及会影响继续运行的辅助实体改为当前时间线祖先链上的追加式版本投影；
  v4、v5、v6、v7 均有升级回归。
- safe-share 新增政策来源脱敏类型，秘密会议关联不会通过公开政策 origin 留在导出包或导入后状态中。
- policy resume 复用统一责任人校验；协办负责人排序采用不改变主负责人语义的稳定 no-op 比较。
- ZIP 在解压前验证 local/central 元数据与数据区域，明确拒绝 data descriptor、加密项和 ZIP64。
- 六个新增正式测试文件覆盖五项复现及 migration，均已纳入 `check:review-fixes`；最终全量门禁结果见本次交付报告。
