# 2026-07-26 · Phase 3 实施记录

## 基线

- 分支：`main`，HEAD `55b96aa`；Phase 1/2 成果位于未提交工作树，本阶段原地增量追加，
  未创建 commit / push / 分支（延续既有约定，提交时机由用户决定）。
- 环境实况：本机仅有 Node v25.2.1 / npm 11.6.2（与 `.nvmrc` 的 24.18.0 不符；engines 为
  `>=24.15 <25`）。npm 对 engines 仅告警。Node 25 移除了 `DatabaseSync.serialize`，
  导致 1 个 Phase 2 测试失败——已改用 `backup()` 落盘读字节（24/25 双兼容）修复；
  其余基线在 Node 25 下全绿。**建议后续统一回 Node 24.18.0 复核一次。**
- 修复的 Phase 2 遗留：`importer.ts` 硬编码 `userVersion !== 1` 版本门（改为接受全部已知
  数据库版本，为迁移 002 让路）。

## 实施结果

- Domain：分层人物卡（ADR-010）、角色知识视图（ADR-011）、人物记忆（ADR-012）、
  Agent 输入输出契约（ADR-014）、人物 API Schema 与 12 个新错误码；旧 CharacterSchema
  原地演进为别名，GameState Schema 未变（无 state 迁移）。
- 数据：魏忠贤/王承恩/黄立极/崔呈秀/袁崇焕 5 张完整人物卡（时点 1627-10-02；袁开局
  dismissed 不可召对）；司礼监机构 + 6 个官职；东林党；《明史纪事本末》《酌中志》入源。
- 视图：六级可见性 + 官职/会议/领域/在朝裁决 + 认知标注；hidden/flags 完全不读取；
  strict Schema 出口校验。
- 记忆：SQLite 迁移 002（character_memories / character_conversation_turns）；仓储、
  Policy 审批（sealed/敏感/去重/上限/可信度收敛）、确定性 Selector + 预算、规则摘要；
  safe_share 导出删除 sealed 记忆。
- Prompt：23 个 v1 资产 + manifest + budget + composer（固定九段、注入标签全角中和、
  累进裁剪、Snapshot 测试）。
- Agent：编排（stale/可交谈/上下文/组合/调用/修复/一致性）、受控修复（默认 1 次，
  专用修复 Prompt）、确定性一致性检查（5 类 error + 2 类 warning）、Mock Fixture
  （support/oppose/evasive/uncertain/invalid-json/schema-error/timeout/unavailable）。
- API/Web：3 个公开 + 3 个 Debug 端点（Debug 生产默认 404）；Character Lab 页签
  （存档/人物/场合/议题/expectedRevision/输出面板/Debug 折叠区）。
- 质量：新增 7 个测试文件；全部 33 个测试文件通过；`check:phase3` 门禁与 CI 步骤就绪；
  `benchmark:phase3` 实测写入 `phase3-benchmark.json`。

## 验证状态

见 Phase 3 最终报告（会话输出）与 `docs/07-phase-3-implementation.md`；
浏览器 Character Lab 实测、恶意输入矩阵、revision 不变与生产 Debug 404 均已实际运行验证。

## 下一步边界

Phase 4 尚未开始。只能在人工评审后实现 Meeting Director、三类会议状态机、多人物发言调度、
议程推进、发言资格、会议记录、泄密风险与会议结果候选。
