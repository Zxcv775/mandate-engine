# ADR-018：会议 Transcript 存储

## 状态

已接受（2026-07-26，Phase 4）。

## 背景

Transcript 是会议的事实记录：必须 append-only、可分页、可按可见性投影、可恢复。

## 决策

- SQLite migration 003 七张 STRICT 表；meeting_turns UNIQUE(meeting_id, turn_number) +
  唯一 action_id 局部索引；全 JSON 列 json_valid；FK 级联到 saves。
- 普通 API 投影 maxVisibility=meeting（sealed/private 仅 Debug），且剥离 privateMetadata。
- 导入导出：七表随存档复制（快进 REPLACE 取新态 / turns IGNORE 去重）；
  safe_share 删除 sealed/private 回合、私密纪要、泄密评估与秘密会议 session；
  分叉导入不携带会议史（记忆随 fork 复制，会议史留在原世界线——已知边界）。
- 不保存 API Key / 完整系统 Prompt；providerTrace 仅安全元数据。

## 状态写边界

Transcript 写入不产生 StateChangeLog。

## 替代方案

Transcript 入 GameState：状态爆炸；入 StateChangeLog：会议发言不是世界状态变更。

## 一致性影响 / 恢复路径

turn_number 唯一约束保证重启重试不产生重复回合；恢复按 meeting_sessions head +
turns 尾部即可重建上下文。

## 安全影响

可见性列上的硬过滤 + safe_share 删除；测试覆盖秘密议事零泄露。

## 回退方案

迁移 003 纯新增；忽略七表即可回退。

## 测试影响

meeting-recovery（append-only/幂等）、meeting-security（投影）、phase4-integration
（safe_share 与重载）。

## 后续升级

大规模 Transcript 可加归档表；分叉会议史复制留待需要时以全键重映射实现。
