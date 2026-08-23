---
type: data-model
title: 数据模型
description: SQLite 五张核心表：明细、日聚合、定价、同步游标、去重账本。
tags: [data-model, sqlite, schema, usage]
resource: src/main/services/db.ts
timestamp: 2026-08-23T03:15:00+08:00
---

# 数据模型

> [!note] 当前状态
> **已实现**（2026-08-20；2026-08-22 schema 升级至 v3；2026-08-23 升级至 v4）。五张表与迁移（v1 建表；v2 为 `model_pricing` 增加 `source` 列；v3 一次性清理存量四项 token 全 0 明细并对受影响日期重建日聚合；v4 修正 opencode 存量行 `input_semantics` 错标 1→2；`PRAGMA user_version` 幂等升级）落地于 `src/main/services/db.ts`，DAO 于 `storage.ts`；数据库文件为数据目录下 `token-monitor.db`。

## 表清单

| 表 | 用途 | 主键/关键字段 |
|---|---|---|
| `usage_records` | 用量明细 | `id`（去重 key = `data_source:file_path:line`） |
| `usage_daily_rollups` | 日聚合镜像（`recordUsage` 实时维护，聚合查询优先读它，见下方「查询语义」） | `(date, app_type, model)` |
| `model_pricing` | 定价（含 `source` 来源分级：`seed`/`sync`/`user`） | `model_id` |
| `sync_cursors` | 增量同步游标 | `file_path` |
| `dedup_ledger` | 去重账本（**已接入写入路径**，2026-08-23；fork/rewrite 语义去重生效） | `(data_source, request_id)` |

索引：明细按 `created_at` 与 `(app_type, created_at)`；游标按 `data_source`；账本按 `semantic_id`。

## 日聚合查询语义

- `usage_daily_rollups` 由 `storage.recordUsage` 在入库同事务实时维护，是明细的**镜像**而非独立主数据。
- `usageQuery.ts` 全部聚合类查询（汇总 / 日趋势 / 按模型 / 按应用）**优先读本表**；筛选条件包含 `status` / `project` / `sessionId` / `keyword` 时回退明细表（rollup 桶不携带这些维度）。
- 明细分页与详情查询始终走明细表，不经 rollups。

## v3 数据修复迁移（已实现，幂等）

与采集端 `isAllZeroUsage` 同口径的一次性存量清洗：

- 一次性 `DELETE` 明细表中 input / output / cache_read / cache_creation **四项全 0** 的历史脏数据。
- 对受影响日期：先清空 `usage_daily_rollups` 当日全部桶，再按剩余明细 GROUP BY 重建（聚合口径与 `recordUsage` 一致，保持 rollup ≡ 组内明细和的不变量）。
- `sync_cursors` 游标**不动**，不影响后续增量同步；重复执行时无全零行即无操作。

## 明细表要点

- `app_type` 直接区分监控对象（插件 id）：`claude / codex / opencode / gemini / grok`（第一阶段，无 provider 维度）。
- `data_source` 与插件 id 对应，标识数据来源插件。
- `model` 为归一化后模型 ID（计费用）；`raw_model` 保留日志原始名。
- `input_semantics`（SSOT 三态）：**0=未知 / 1=input 为含缓存读写的总量（计费前需扣减缓存）/ 2=input 已为纯新输入**。五源实际取值：claude=2、codex=1、opencode=2（上游已自行扣减）、gemini=1、grok=1；费用侧按此扣减，见 [定价与费用](pricing.md)。
- 费用精度：`cost_usd` 以字符串存储避免浮点误差，聚合时统一转为整数微美元累加再回写字符串。
- `project` / `session_id` 记录会话归属（可选）；`status` 默认 `'success'`。
- `source.requestId`（dto 层可选字段）：稳定语义请求 ID（如上游消息 UUID），入库时写入 `dedup_ledger` 用于跨文件/重写场景去重；不单独建列。

## 去重账本（dedup_ledger，已接入）

- 写入时机：`storage.recordUsage` 入库事务内——明细 INSERT 成功且记录携带 `requestId` 时回填 `(data_source, request_id, semantic_id, created_at)`；同事务先查后写保证原子。
- 判定：下一轮同步遇到相同 `(data_source, request_id)` 直接跳过（不入明细、不计 rollup、不计 addedRecords）；覆盖「同一逻辑请求出现在不同 file_path/line」的 fork/rewrite 场景。
- `semantic_id` 为 sha256 指纹前 16 位（仅存证，当前判定按 request_id 直配）；无 requestId 的记录退回主键去重，不写账本。

## 保留策略（已接线）

- 默认 **90 天**（`retentionDays=90`，可在设置中修改），清理只删 `usage_records` 明细，**rollups 永不清理**；`retentionDays <= 0` 视为不清理。
- 清理调度已由宿主 `host.ts` 接线：启动延迟 30s 执行一次，并经 scheduler 以 `syncIntervalMs` 同间隔周期执行；设置变更联动重启调度，dispose 可逆。
- 到期明细删除后，历史趋势因 rollups 镜像完整保留，聚合查询不受清理影响。

## 与监控插件的扩展关系

- 首版**不引入 provider 维度**（无代理），`app_type` 直接对应插件 id。
- 新增监控插件时，其 `id` 即新的 `app_type` 取值；`data_source`、`sync_cursors.file_path` 天然按插件隔离，无需改表结构。

## 关联页面

- [监控插件](monitor-plugins.md) — `app_type` 与插件 id 的对应。
- [数据流](data-flow.md) — 明细与聚合的写入路径。
- [定价与费用](pricing.md) — 定价表的使用。
- [同步与去重](sync-mechanism.md) — 游标与去重账本。
- [返回目录](../index.md)
