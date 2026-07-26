# Phase 2 性能基准

- 生成时间：2026-07-26T12:14:46.760Z
- 环境：win32 10.0.26100 / AMD Ryzen 9 8940HX with Radeon Graphics         / Node v24.18.0
- Fixture：revision 1000，日志 10000，重复 5 次

## 耗时（ms）

| 操作 | 次数 | 平均 | 最小 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| createSave | 1 | 28.644 | 28.644 | 28.644 |
| loadRevision0 | 5 | 0.347 | 0.304 | 0.382 |
| commitSingleMutation | 5 | 4.113 | 3.492 | 5.488 |
| createCheckpoint | 1 | 5.99 | 5.99 | 5.99 |
| loadRevision100 | 5 | 0.181 | 0.141 | 0.279 |
| loadRevision1000 | 5 | 0.198 | 0.161 | 0.286 |
| replay50 | 5 | 5.47 | 4.932 | 6.722 |
| replay100 | 5 | 10.463 | 10.231 | 11.04 |
| commitTenMutations | 5 | 5.088 | 2.879 | 7.264 |
| exportSave | 5 | 132.115 | 124.513 | 137.372 |
| importSave | 1 | 116.711 | 116.711 | 116.711 |
| validateSave | 5 | 375.392 | 370.409 | 383.569 |

## 体积（bytes）

- 单条日志平均负载：248.946
- 10000 条日志数据库：11694080
- snapshot/50：3063808
- snapshot/100：3133440
- 导出（含来源目录）：684725
- 导出（剥离来源目录）：6645
- WAL 观测值：4190072

## 异常值

- 本次 snapshot/100 文件未小于 snapshot/50；SQLite 页分配与工作负载差异使文件大小不具单调性

## 估算前提

- loadRevision1000 使用本次 fixture 的最大 revision 1000
- replay50/replay100 分别代表从初始 snapshot 重放至最多 50/100 个 revision
- tenThousandLogDatabaseBytes 对应本次实际 10000 条日志；正式基准目标为 10000
- 平均日志大小是固定列与 JSON/BLOB 负载之和，不含 SQLite B-tree 页开销
- WAL 数值是工作负载结束时观测值，不是持续采样的绝对峰值
