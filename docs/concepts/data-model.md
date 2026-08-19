---
type: data-model
title: 数据模型
description: SQLite 五张核心表：明细、日聚合、定价、同步游标、去重账本。
tags: [data-model, sqlite, schema, usage]
timestamp: 2026-08-19T20:25:00+08:00
---

# 数据模型

> [!note] 当前状态
> 规划阶段，表结构为设计草案，尚无 migrations 实现。

## 表清单

| 表 | 用途 | 主键/关键字段 |
|---|---|---|
| `usage_records` | 用量明细 | `id`（去重 key = data_source + file_path + line） |
| `usage_daily_rollups` | 日聚合（趋势主数据源） | `(date, app_type, model)` |
| `model_pricing` | 定价 | `model_id` |
| `sync_cursors` | 增量同步游标 | `file_path` |
| `dedup_ledger` | 去重账本（fork/rewrite） | `(data_source, request_id)` |

## 明细表要点

- `app_type` 直接区分监控对象（插件 id）：`claude / codex / opencode / gemini / grok`（第一阶段，无 provider 维度）。
- `data_source` 与插件 id 对应，标识数据来源插件。
- `model` 为归一化后模型 ID（计费用）；`raw_model` 保留日志原始名。
- `input_semantics`：0=未知 / 1=含缓存写 / 2=纯新输入。
- `cost_usd` 用字符串避免浮点误差（或整数微单位）。
- `project` / `session_id` 记录会话归属（可选）。

## 与监控插件的扩展关系

- 首版**不引入 provider 维度**（无代理），`app_type` 直接对应插件 id。
- 新增监控插件时，其 `id` 即新的 `app_type` 取值；`data_source`、`sync_cursors.file_path` 天然按插件隔离，无需改表结构。

> [!todo] 待补充
> - 明细保留策略（默认保留 N 天）的具体 N 值尚未定。
> - 定价表默认 seed 数据的具体模型清单尚未落地。

## 关联页面

- [监控插件](monitor-plugins.md) — `app_type` 与插件 id 的对应。
- [数据流](data-flow.md) — 明细与聚合的写入路径。
- [定价与费用](pricing.md) — 定价表的使用。
- [同步与去重](sync-mechanism.md) — 游标与去重账本。
- [返回目录](../index.md)
