# Phase 2 性能基准

- 生成时间：2026-07-26T07:55:28.771Z
- 环境：win32 10.0.26100 / AMD Ryzen 9 8940HX with Radeon Graphics         / Node v24.18.0
- Fixture：revision 1000，日志 10000，重复 5 次

## 耗时（ms）

| 操作 | 次数 | 平均 | 最小 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| createSave | 1 | 23.902 | 23.902 | 23.902 |
| loadRevision0 | 5 | 0.321 | 0.269 | 0.421 |
| commitSingleMutation | 5 | 3.935 | 3.194 | 5.81 |
| createCheckpoint | 1 | 6.23 | 6.23 | 6.23 |
| loadRevision100 | 5 | 0.211 | 0.175 | 0.309 |
| loadRevision1000 | 5 | 0.221 | 0.191 | 0.242 |
| replay50 | 5 | 4.597 | 3.783 | 5.83 |
| replay100 | 5 | 6.896 | 6.116 | 8.011 |
| commitTenMutations | 5 | 4.546 | 3.166 | 5.537 |
| exportSave | 5 | 157.214 | 125.368 | 173.066 |
| importSave | 1 | 154.233 | 154.233 | 154.233 |
| validateSave | 5 | 73.872 | 70.886 | 84.01 |

## 体积（bytes）

- 单条日志平均负载：248.946
- 10000 条日志数据库：11554816
- snapshot/50：2973696
- snapshot/100：3076096
- 导出（含来源目录）：681899
- 导出（剥离来源目录）：5013
- WAL 观测值：4185952

## 异常值

- 本次 snapshot/100 文件未小于 snapshot/50；SQLite 页分配与工作负载差异使文件大小不具单调性

## 估算前提

- loadRevision1000 使用本次 fixture 的最大 revision 1000
- replay50/replay100 分别代表从初始 snapshot 重放至最多 50/100 个 revision
- tenThousandLogDatabaseBytes 对应本次实际 10000 条日志；正式基准目标为 10000
- 平均日志大小是固定列与 JSON/BLOB 负载之和，不含 SQLite B-tree 页开销
- WAL 数值是工作负载结束时观测值，不是持续采样的绝对峰值
