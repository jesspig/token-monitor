---
type: data-model
title: 数据模型
description: SQLite 六张核心表、schema v14、requestId 明细列、可替换成功快照事务、日/小时聚合与同步游标。
tags: [data-model, sqlite, schema, usage, request-id, snapshot]
resource: src/main/services/db.ts
timestamp: 2026-09-11T12:03:38+08:00
---

# 数据模型

> [!note] 当前状态
> 当前数据库 schema 为 **v14**。v14 在不覆盖存量数据的前提下，为 `usage_records` 增加 `request_id` 与 `is_replaceable_snapshot`，并建立同源非空 requestId 唯一部分索引。验证基线：typecheck 两段通过、vitest 54 文件 / 1166 用例通过、`pnpm build` 通过。

## 核心表

| 表 | 用途 | 主键/关键字段 |
|---|---|---|
| `usage_records` | 请求明细与当前成功快照 | `id`；v14 增 `request_id`、`is_replaceable_snapshot` |
| `usage_daily_rollups` | 日聚合镜像，永久保留 | `(date, app_type, model)` |
| `usage_hourly_rollups` | 小时聚合镜像，永久保留 | `(date, hour, app_type, model)` |
| `model_pricing` | 模型定价与来源 | `model_id` |
| `sync_cursors` | 行游标、mtime、可选字节游标 | `file_path` |
| `dedup_ledger` | 同源 requestId 语义账本 | `(data_source, request_id)` |

数据库文件位于应用数据目录的 `token-monitor.db`，自 v10 起使用 WAL。统计查询在文件数据库模式下通过只读 worker 连接读取已提交快照。

## `usage_records` 当前结构

```sql
CREATE TABLE usage_records (
  id                      TEXT    NOT NULL PRIMARY KEY,
  data_source             TEXT    NOT NULL,
  app_type                TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  raw_model               TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
  input_semantics         INTEGER NOT NULL DEFAULT 0,
  cost_usd                TEXT,
  currency                TEXT,
  latency_ms              INTEGER,
  project                 TEXT,
  session_id              TEXT,
  status                  TEXT    NOT NULL DEFAULT 'success',
  http_status             INTEGER,
  error_message           TEXT,
  file_path               TEXT    NOT NULL,
  line                    INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  request_id              TEXT,
  is_replaceable_snapshot INTEGER NOT NULL DEFAULT 0
                            CHECK (is_replaceable_snapshot IN (0, 1))
);

CREATE UNIQUE INDEX idx_usage_records_data_source_request_id
  ON usage_records(data_source, request_id)
  WHERE request_id IS NOT NULL;
```

要点：

- `id=<data_source>:<file_path>:<line>` 仍是内部主键和证据位置幂等键。
- `request_id` 保存 `UsageRecord.source.requestId`，用于跨文件、重写、迁移和可替换快照定位；不再只存在于 `dedup_ledger`。
- `is_replaceable_snapshot=1` 只表示允许参与受控更新，不代表任意后到记录可覆盖。
- v14 迁移后所有旧行默认 `request_id=NULL`、`is_replaceable_snapshot=0`，不重写历史记录。
- 同一 requestId 可在不同 `data_source` 下独立存在；同源非空 requestId 只能对应一条明细。

## 可替换快照写入语义

`storage.recordUsage` 对同源 requestId 执行以下决策：

1. 没有现有明细时正常插入，并持久化 requestId 与快照标记。
2. 已有明细且新旧均为成功、均可替换时，可更新原行；数据库主键保持不变。
3. 完全相同的快照为 no-op，返回变更数 0。
4. 旧或新任一不可替换、任一状态不是 success，均保持 first-write-wins。
5. ledger 已存在但无法定位带 requestId 的明细时保守跳过，不猜测迁移旧行。
6. 有效替换更新模型、Token 四桶、input semantics、费用、耗时、项目、会话、状态、错误字段、证据路径/行号和时间。
7. 事务重新聚合受影响的旧、新日桶和小时桶；空桶删除。费用以微美元整数汇总后写回字符串。
8. 明细、ledger 或任一 rollup 更新失败时整体回滚。

当前可替换来源按条件启用：

- Claude：成功且有稳定 `message.id`。
- Kiro current SQLite：当前 `data.sqlite3` 中有稳定 turn 身份的成功记录；旧 sidecar 不可替换。
- Droid：成功且有稳定 `message.id` 的 JSONL usage；settings 文件不产出记录。

## 输入计费语义

`input_semantics`：

- `0`：input 与缓存是否重叠未知。
- `1`：input 含缓存总量，计费前扣除 cache read/write。
- `2`：input 已是纯新输入。

逐源当前规则：

- 1：Codex、Gemini、Grok、Zcode、WorkBuddy、CodeBuddy、Qwen、Reasonix、Goose、Copilot CLI。
- 2：Claude、OpenCode、Pi、DSH、Cline、Roo Code、Kimi、Zed、Command Code、Copilot Chat、DevEco、MiMo、gptme、Droid、MiniMax。
- 0：Qoder、Qoder CN、Kiro、CodeWhale。
- Kilo：当前 `kilo.db` 为 0；旧扩展快照为 2。
- Trae Agent：按 provider 逐行决定，Anthropic 系为 2，已验证的 OpenAI 等分支为 1。

`idx_usage_records_cached_input` 仍按 v13 的十源候选优化存量费用重算；v14 未改变该索引和计费公式。

## 同步游标

`sync_cursors` 保存：

- `line_offset`：行号、rowid、数组位置或插件编码的安全整数。
- `file_mtime`：mtime 短路和替换检测。
- `byte_offset`：DSH zstd 已安全消费的帧末尾字节位置。
- `data_source/updated_at`：归属和更新时间。

OpenCode/DevEco/MiMo 的 `line_offset` 现为数据库指纹 + rowid 编码值，不再是 `time_created`。CodeWhale 使用会话指纹 + Token 基线编码值；Kiro current 使用固定重读标志并由数据库/WAL mtime 判断变化。

## 聚合表与查询

- `recordUsage` 对新增记录增量维护日、小时聚合。
- 可替换快照不直接做简单差值累加，而是从受影响桶的当前明细重新聚合，覆盖跨日期、小时或模型变化。
- 日聚合供无细维度筛选的日趋势和 `getDailyModelBreakdown` 快路径。
- 小时聚合供无细维度筛选的小时趋势。
- status/project/sessionId/keyword/httpStatus 等 rollup 不具备的筛选条件回退 `usage_records`。
- 明细可按保留策略删除，日/小时 rollup 永不清理。

## schema 迁移摘要

| 版本 | 关键变化 |
|---|---|
| v1 | 建立核心表 |
| v2 | 定价来源字段 |
| v3 | 清理成功全零历史明细并重建日聚合 |
| v4 | 修正 OpenCode input semantics |
| v5 | 清理 DSH 脏游标 |
| v6 | `sync_cursors.byte_offset` |
| v7 | 零成本与缓存口径部分索引 |
| v8 | `http_status/error_message` |
| v9 | 清游标回填历史失败 |
| v10 | 小时聚合、筛选索引、WAL |
| v11 | `(model, created_at)` 联合索引 |
| v12 | 缓存口径候选扩为七源 |
| v13 | 缓存口径候选扩为十源 |
| **v14** | `usage_records.request_id`、`is_replaceable_snapshot`、同源 requestId 唯一部分索引 |

所有迁移由 `PRAGMA user_version` 顺序执行。v14 的列和索引均有幂等守卫，不删除、覆盖或重算存量明细。

## 失败记录

- `status` 为 `success` 或 `error`；取消/中断由插件层忽略。
- `http_status/error_message` 仅错误记录有效；错误文案最长 500 字符。
- 错误记录即使四桶全 0 也可入库。
- 错误记录不可被成功快照替换，成功快照也不可覆盖不可变错误事件。

## 关联页面

- [监控插件](monitor-plugins.md)
- [同步与去重](sync-mechanism.md)
- [数据流](data-flow.md)
- [定价与费用](pricing.md)
- [返回目录](../index.md)
