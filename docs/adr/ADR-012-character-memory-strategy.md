# ADR-012：人物记忆策略

## 状态

已接受（2026-07-26，Phase 3）。

## 背景

人物需要跨对话的记忆，但记忆不是客观真相、不是世界状态，也不能是无限聊天记录。
本阶段明确禁止向量数据库。

## 决策

- 记忆独立于 GameState：SQLite 新表 `character_memories` 与 `character_conversation_turns`
  （migration `002-character-memories`，user_version 1→2）。写入不产生 StateChangeLog、
  不改变 revision 与状态 Hash。
- 记忆结构带来源锚点：sourceRevision / sourceType（observed/told/official-record/rumor/
  inference/agent-generated-summary）/ confidence / importance / visibility(self/private/
  shareable/sealed) / status(active/outdated/contradicted/forgotten)。
- 写入边界：Agent 只产出 memoryCandidates → Zod 校验 → Memory Policy（sealed 拒绝、
  敏感模式拒绝、内容哈希去重、单角色上限、按来源收敛可信度上限：rumor≤60/inference≤70/
  摘要≤80）→ Application Service 批准 → 仓储落库。候选必须可被拒绝。
- 检索用确定性规则评分（无向量）：topic + entity + importance×0.3 + confidence×0.1 +
  recency − outdatedPenalty(25) − contradictedPenalty(40)，同分按 memoryId 字典序；
  预算三限（maxItems/maxCharacters/maxEstimatedTokens）+ 单条 500 字上限。
- 摘要为纯规则压缩（不经 LLM）：只取材原文、保留被压缩 memoryIds 与 revision 范围、
  低可信内容显式标注、禁止跨人物合并。
- 导出：记忆随 `.mesave` 载荷同库导出；safe_share 模式删除全部 sealed 记忆。

## 选择理由

Phase 3 的记忆量级（百千条）下，规则评分完全可复现、可单测、可离线跑 CI；
revision 锚点让"信息过时"成为可计算属性；写入审批链把 LLM 挡在持久化之外。

## 替代方案

- 向量数据库 / RAG：明确禁止；引入部署与不确定性成本，且难以确定性测试。
- 记忆放进 GameState：会让 Agent 输出间接获得状态写路径，违反 ADR-002。
- 保存全部对话原文进上下文：Token 失控，违背预算原则。

## 后果

语义近似检索能力有限（同义词不匹配）；跨库导入暂不迁移记忆行（存档行照常导入）。

## 风险

规则评分权重是工程标定，可能需要按玩法调参——集中在 memory-selector 一处。

## 回退方案

迁移 002 为纯新增表；忽略两表即可回退功能，存档主链路无依赖。

## 测试影响

`tests/character-memory.test.ts` 15 用例：仓储 CRUD/过滤/分页、审批拒绝矩阵、
排序与惩罚、预算、sealed/forgotten 硬过滤、摘要不新增事实、记忆写入不动 revision。

## 兼容性影响

旧存档打开时自动前向迁移到 user_version 2；旧版 `.mesave` 载荷（user_version 1）仍可导入。
