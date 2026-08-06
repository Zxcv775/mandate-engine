# Phase 5 第四轮代码审查修复记录（2026-07-28）

## 范围

本轮只处理第三轮独立复审确认的四项问题，未进入 Phase 6：

1. safe-share 传递引用泄漏；
2. 政策进入 `issued` / `implementing` 前的责任资格守卫；
3. meeting ruling 的回滚时间线幂等；
4. ZIP flags 与单磁盘 EOCD 边界。

## 实现摘要

- safe-share 在源库上先收集被剥离实体的 forbidden ID，在导出副本中删除私密实体、清理
  GameState 与 SQLite JSON 结构化引用，并对最终语义 payload 做精确 ID 断言；公开来源保留。
- `validatePolicyResponsibility` 成为 issue、resume、blocked adjust 与自动 resolution 的统一领域
  守卫；非法负责人不会触发状态、资源或政策明细副作用。
- Migration 009 删除跨全部历史的 ruling 唯一索引，改为时间线查询普通索引，数据库版本升至
  9；当前祖先链查询、expectedRevision 与同事务写入共同保证幂等和并发原子性。
- ZIP importer 仅接受 exporter 实际生成的 flags `0`，拒绝加密、data descriptor、bit 6、
  未知位与多磁盘 EOCD；格式错误稳定映射为 HTTP 422。
- flattened safe-share 存档的完整性检查以最早快照作为 revision 连续性锚点，使导入后命令与
  逻辑回滚保持可验证。

## 回归结果

- 聚焦回归：11 个文件、104 项通过。
- `npm test`：59 个文件、507 项通过。
- `npm run check:review-fixes`：17 个文件、134 项通过（分组统计，存在共享覆盖）。
- `npm run check:phase2`、`check:phase3`、`check:phase4`、`check:phase5` 全部通过。
- `lint`、`typecheck`、`build`、`check:data`、`format:check`、`git diff --check` 通过。

验证环境为 Node 25.2.1 / npm 11.6.2；本机仅发现的 Codex Node 24 为 24.14.0，低于项目
`>=24.15.0 <25` 的支持范围，因此 Node 24 支持环境门禁仍待独立复审补验。验证过程未触网。

## Git 与后续

- 分支保持 `phase5/policy-engine`，HEAD 保持
  `610c48d45d4f4ce187473b608bc8c06d198dd826`。
- 未执行 commit、push、merge、PR、reset、stash、clean、restore 或 checkout。
- 下一步：第四轮独立、只读、聚焦代码复审。
