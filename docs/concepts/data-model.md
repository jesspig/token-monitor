---
type: data-model
title: 数据模型
description: SQLite 六张核心表：明细、日聚合、定价、同步游标、去重账本；失败可观测性扩展（http_status/error_message，v8/v9）；小时物化 v10 与模型-时间联合索引 v11。
tags: [data-model, sqlite, schema, usage, failure-observability]
resource: src/main/services/db.ts
timestamp: 2026-08-29T14:40:04+08:00
---

# 数据模型

> [!note] 当前状态
> **已实现**（2026-08-20；2026-08-22 schema 升级至 v3；2026-08-23 升级至 v4；2026-08-25 升级至 v5；2026-08-26 升级至 v6/v7；**2026-08-27 升级至 v8/v9——失败可观测性**；**同日升级至 v10——小时粒度物化 `usage_hourly_rollups` + `usage_records` 三筛选索引**；**2026-08-29 升级至 v11——`usage_records` 新增联合索引 `idx_usage_records_model_created(model, created_at)`**）。六表与迁移（v1 建表；v2 为 `model_pricing` 增加 `source` 列；v3 一次性清理存量四项 token 全 0 明细并对受影响日期重建日聚合；v4 修正 opencode 存量行 `input_semantics` 错标 1→2；v5 清除 dsh 会话文件脏游标触发全量重析；v6 为 `sync_cursors` 增可空列 `byte_offset` 字节游标；v7 为 `usage_records` 新增两个部分索引服务回填/重算候选扫描；**v8 为 `usage_records` 新增 `http_status` / `error_message` 失败可观测列（INTEGER/TEXT，仅失败有效，存量 NULL，见下方 v8）；v9 清空 `sync_cursors` 触发失败记录存量回溯全量重析（见下方 v9）**；**v10 新增 `usage_hourly_rollups` 小时聚合物化表（日聚合镜像的小时版，见下方 v10）并为 `usage_records` 增加 `status` / `project` / `session_id` 三单列索引（服务状态与归属维度筛选，见索引章节）**；**v11 新增 `idx_usage_records_model_created(model, created_at)`（见下方 v11，支撑 `getDailyModelBreakdown` 的 `model + created_at` 范围过滤，24h/7d 等趋势查询由预聚合快路径覆盖后该索引主要兜底带维度过滤的回退明细路径）**；`PRAGMA user_version` 幂等升级）落地于 `src/main/services/db.ts`，DAO 于 `storage.ts`；数据库文件为数据目录下 `token-monitor.db`，**自 v10 起启用 WAL（`journal_mode = WAL`，见下方「WAL 与并发读」）**。

## 表清单

| 表 | 用途 | 主键/关键字段 |
|---|---|---|
| `usage_records` | 用量明细 | `id`（去重 key = `data_source:file_path:line`） |
| `usage_daily_rollups` | 日聚合镜像（`recordUsage` 实时维护，聚合查询优先读它，见下方「查询语义」） | `(date, app_type, model)` |
| `usage_hourly_rollups` | 小时粒度聚合物化表（`recordUsage` 同事务增量维护，前端「按小时下钻 / 实时筛选」优先读它，见下方「v10 迁移」） | `(date, hour, app_type, model)` |
| `model_pricing` | 定价（含 `source` 来源分级：`seed`/`sync`/`user`） | `model_id` |
| `sync_cursors` | 增量同步游标（v6 起含可空 `byte_offset` 压缩字节游标，dsh zstd 用） | `file_path` |
| `dedup_ledger` | 去重账本（**已接入写入路径**，2026-08-23；fork/rewrite 语义去重生效） | `(data_source, request_id)` |

索引：明细按 `created_at` 与 `(app_type, created_at)`；游标按 `data_source`；账本按 `semantic_id`；v7 起明细另有两个部分索引（见下方「v7 部分索引迁移」）；**v8 新增的 `http_status` / `error_message` 不建独立索引**——失败记录占比极低（<1%），查询复用已有 `created_at` / `(app_type, created_at)` 的时间范围扫描即可，单列/部分索引增写入开销而收益可忽略（见 [同步与去重](sync-mechanism.md) 索引说明与 `usageQuery.ts` 的 `buildWhere` 函数实现）；**v10 起明细新增 `idx_usage_records_status(status)` / `idx_usage_records_project(project)` / `idx_usage_records_session_id(session_id)` 三单列索引（见下方「v10 迁移」），小时表另有 `idx_usage_hourly_rollups_date(date, app_type)`**；**v11 新增 `idx_usage_records_model_created(model, created_at)`（见下方 v11）**。

## 日聚合查询语义

- `usage_daily_rollups` 由 `storage.recordUsage` 在入库同事务实时维护，是明细的**镜像**而非独立主数据；桶字段含 `request_count / success_count / error_count`（`status='error'` 时 `error_count++`，否则 `success_count++`，见 `storage.ts:recordUsage`），费用与 token 的聚合口径与明细一致。
- `usageQuery.ts` 全部聚合类查询（汇总 / 日趋势 / 按模型 / 按应用）**优先读本表**；筛选条件包含 `status` / `httpStatus`（含别名 `statusCode`）/ `project` / `sessionId` / `keyword` 时回退明细表（rollup 桶不携带 `http_status`/`error_message`/`status` 细筛与文本维度，下推会丢条件，见 `usageQuery.ts:canUseRollups` / `buildWhere` / `buildRollupWhere`）。
- 明细分页与详情查询始终走明细表，不经 rollups（失败筛选 `status='error'` / `http_status=429` 等在明细表以 `WHERE status=? AND http_status=?` 精确过滤，复用 `created_at` 时间索引范围扫描）。

## 小时聚合查询语义（v10 起）

- `usage_hourly_rollups` 为 `usage_daily_rollups` 的**小时版镜像**，桶字段口径完全一致（request_count / success_count / error_count / 各 token / cost_usd / latency_ms_total），主键升级为 `(date, hour, app_type, model)`（hour 为本地时区 0–23 整点）。
- 由 `storage.recordUsage` 在入库**同事务**增量维护（与日桶同口径累桶，按 `(date,hour,app_type,model)` 查现有值后 `ON CONFLICT DO UPDATE` 累加，回放幂等），非独立主数据。
- `usageQuery.queryHourlyRows`（`getHourlyTrends` 底层）读路径：**无筛选维度时（即 `canUseRollups(filters)` 为真，不含 status/project/sessionId/keyword/httpStatus）读 `usage_hourly_rollups` 小表**，按 `date BETWEEN ? AND ?` 取候选，可选附带 `app_type IN (...)` / `model IN (...)` 过滤，再按精确时间窗裁剪（rollup 按整天归桶，剔除首尾越界钟点桶），与对明细全扫结果一致；**任一筛选维度存在时回退 `usage_records` 全扫**（GROUP BY `day_key, hour`），保持原有行为（rollup 桶不携带 status/project/sessionId/keyword 细筛维度，下推会丢条件）。
- WAL 与并发读：`createDatabase` 已设 `journal_mode = WAL`，统计查询经 worker 线程只读连接（见 [总体架构](architecture.md) 与 [数据流](data-flow.md)）读已提交快照，不阻塞主线程写者。

## v3 数据修复迁移（已实现，幂等）

与采集端 `isAllZeroUsage` 同口径的一次性存量清洗：

- 一次性 `DELETE` 明细表中 input / output / cache_read / cache_creation **四项全 0** 的历史脏数据。
- 对受影响日期：先清空 `usage_daily_rollups` 当日全部桶，再按剩余明细 GROUP BY 重建（聚合口径与 `recordUsage` 一致，保持 rollup ≡ 组内明细和的不变量）。
- `sync_cursors` 游标**不动**，不影响后续增量同步；重复执行时无全零行即无操作。

## v5 脏游标清除迁移（已实现，幂等）

- 一次性 `DELETE FROM sync_cursors WHERE file_path LIKE '%\.dsh\sessions%'`，清除 dsh 会话文件的脏游标。
- 成因：dsh 初版适配器模型两级来源在真实数据上全部失效（`data.message.model` 全量缺失、request/header 兜底未命中），解析零产出但采集器照常把游标推进到文件末尾；后续三级来源修复又被 mtime 短路（游标与 mtime 一致即跳过）挡住，历史文件永不重析——清游标是绕过短路的自愈入口（见 [同步与去重](sync-mechanism.md)）。
- 重放安全性：迁移执行时 `usage_records` 无任何 dsh 行、`dedup_ledger` 为空；重析后 `INSERT OR IGNORE` 主键幂等 + requestId 语义去重收敛，无重复计数风险。实测两轮启动完成全量重析：120/120 个 dsh 会话文件游标回写，6084 条 dsh 记录入库（与上游 assistant/message 总数精确吻合），dedup_ledger 同步 6084 条。

## v6 字节游标列迁移（已实现，幂等）

- `ALTER TABLE sync_cursors ADD COLUMN byte_offset INTEGER`（可空）：为 dsh `.jsonl.zstd` 工件记录「已安全消费到的压缩字节偏移」，续读只解压新增帧（见 [监控插件](monitor-plugins.md)）。
- 可空语义：NULL = 未知（存量行与非法/脏偏移一律），消费方回退整块解压自愈，靠主键幂等去重兜底不丢数据。
- schema 级幂等：ALTER 前以 `pragma table_info(sync_cursors)` 做列存在性守卫，列已存在即跳过——ALTER 重放会报 duplicate column，与 v3/v4/v5 的数据级幂等一致，保证 `user_version` 回拨重放历史迁移安全。
- DAO 配套（storage.ts）：`getCursorMeta` 返回 `byteOffset`；`setCursor(filePath, line, fileMtime?, byteOffset?)` 缺省保留现值、显式传入（含 null）覆盖、truncate 重置时行号与 byte_offset 双清（单语句 upsert，@keep_byte_offset / @reset_cursor 控制位）；truncate 判定收紧——既有 `file_mtime = 0`（占位）不参与变化判定。

## v7 部分索引迁移（已实现，幂等）

- 创建两个部分索引，WHERE 子句与各自候选查询条件完全一致，使候选枚举走 index scan：
  - `idx_usage_records_zero_cost ON usage_records (cost_usd) WHERE cost_usd IS NULL OR cost_usd = '0'`——零成本回填的候选行；
  - `idx_usage_records_cached_input ON usage_records (input_semantics) WHERE input_semantics = 1 AND app_type IN ('codex', 'gemini', 'grok')`——存量缓存口径重算的候选行。
- 动机（2026-08-26 防阻塞第二轮）：两个候选查询此前无任何可用索引，每次执行都是 `usage_records` 全表过滤扫描，且为周期任务、成本随明细量线性上涨；部分索引把稳态扫描成本降为 O(候选数)——稳态下候选集仅为「永久缺价/全免费定价」的滞留行，体量极小。
- 幂等：`CREATE INDEX IF NOT EXISTS` 保证 user_version 回拨重放安全。配合分批执行消除长事务，见 [定价与费用](pricing.md)。

## v8 失败可观测性列迁移（已实现，幂等，2026-08-27）

- `ALTER TABLE usage_records ADD COLUMN http_status INTEGER` / `ADD COLUMN error_message TEXT`（可空）：为失败请求持久化 HTTP 状态码与错误文案。**仅失败有效**——`status='error'` 时写入，成功/中断为 `NULL`；存量行保持 `NULL`（`ADD COLUMN` 默认），旧库重放安全。
- 类型与约束：`http_status` 为 `INTEGER`（如 400/401/403/429/500/529 等），`error_message` 为 `TEXT` 且由存储层 `toUsageRecordRow` 按 `shared/failure.ts:ERROR_MESSAGE_MAX_LENGTH=500` 截断后写入（DTO 层不限长，入库前收敛，超长 `slice(0,500)`，性能 O(1)）。
- 幂等：`PRAGMA table_info(usage_records)` 列存在性守卫，列已存在即跳过 `ALTER`——避免 `duplicate column` 报错，与 v6 风格一致，保证 `user_version` 回拨重放历史迁移安全。
- 索引策略：**不建索引**——失败记录占比极低，查询侧由 `usageQuery.ts:buildWhere` 复用已有 `idx_usage_records_created_at` / `idx_usage_records_app_created` 的时间范围扫描即可；单列或部分索引会增加每次 `INSERT OR IGNORE` 的写入放慢而收益可忽略。`status='error'` + `http_status` 联合筛选回退明细表（rollup 无该列，下推会丢条件，见 `usageQuery.ts:canUseRollups`）。
- 关联：DTO `UsageRecord.httpStatus? / errorMessage?`（`shared/dto.ts`）→ 行 `http_status / error_message`（`shared/tables.ts:UsageRecordRow`）→ 查询 `RequestLogDetail.httpStatus / errorMessage`（`shared/query.ts`）；校验与截断 SSOT 见 `shared/failure.ts`。

## v9 存量回溯迁移（已实现，幂等，2026-08-27）

- 一次性 `DELETE FROM sync_cursors` 清空全部游标，触发下一轮全量重析以回填**历史失败记录**。
- 成因：失败接入前（v8 前无 `http_status`/`error_message` 列，且 `collector.isAllZeroUsage` 对四项全 0 记录一律拦截），历史失败请求从未入库，但其会话文件的 `sync_cursors` 游标已推进到文件末尾；`collector` 的 mtime 短路（游标与文件 mtime 一致且均非 0 时跳过解析）又挡住存量重析，导致历史失败永不回填。
- 作用域选择：全量 `DELETE` 而非按 `data_source IN (...)` 或 `file_path LIKE` 过滤——失败语义横跨全部 8 个内置源（claude/codex/opencode/gemini/grok/pi/zcode/dsh），且早期游标 `data_source` 可能为空字符串（`setCursor` 未显式写入），`IN` 过滤会漏删；`LIKE` 需枚举多套路径模式亦不完备，全量更稳且幂等。
- 单事务与性能：由 `migrate()` 外层 `db.transaction` 包裹 `m.up + PRAGMA user_version`，仅一次 `fsync`；稳态重析一轮后游标即按 `parsed.nextLine` 重建，后续增量仍走 mtime 短路，开销仅首轮一次全量解析。
- 幂等与去重：`DELETE` 重复执行无影响（无游标时 deletes 0 行）；重放由双层幂等保证——`usage_records` 主键 `id=data_source:file_path:line` 的 `INSERT OR IGNORE`（`storage.ts:insertRecordStmt`，`info.changes===0` 跳过不累 rollup/事件）+ `dedup_ledger` 主键 `(data_source, request_id)` 的 `INSERT OR IGNORE`（与明细同事务），成功记录因主键冲突跳过、仅新增的失败记录正常入库且增量修正 `usage_daily_rollups.error_count`，无重复计数风险。
- 与本次迭代的联动：`collector.isAllZeroUsage` 已对 `status='error'` 放行全零（失败零 token 可观测），`storage.toUsageRecordRow` 已对 `errorMessage` 截断 500，v9 清游标是该放行的存量入口。

## v10 小时物化 + 筛选索引迁移（已实现，幂等，2026-08-27）

- 新增表 `usage_hourly_rollups`（DDL 见下方「小时聚合物化表结构」）：为前端「按小时下钻 / 实时筛选」提供聚合结果缓存，避免每次小时查询对 `usage_records` 全表聚合；桶字段与日聚合镜像口径一致。
- 一次性回填：迁移以 `strftime('%Y-%m-%d'/'%H', created_at/1000, 'unixepoch', 'localtime')` 对 `usage_records` 按 `(date, hour, app_type, model)` GROUP BY 聚合，经 JS 循环复用 `microUsdToCostString`（微美元→字符串，与 storage/usageQuery 口径一致）写入；在 `db.transaction` 单事务内完成，仅一次 `fsync`。
- 幂等：`CREATE TABLE/INDEX IF NOT EXISTS` + `INSERT OR REPLACE` 保证 `user_version` 回拨重放得相同聚合值、不会翻倍；与 v3/v4/v5 的数据级幂等一致。
- 三单列索引（服务于状态与归属维度筛选）：`idx_usage_records_status ON usage_records(status)`、`idx_usage_records_project ON usage_records(project)`、`idx_usage_records_session_id ON usage_records(session_id)`；配合 v10 小时表的 `idx_usage_hourly_rollups_date(date, app_type)`。
- 保留策略不受影响：同日/小时聚合镜像，`usage_hourly_rollups` **永不清理**，明细到期删除后历史趋势因镜像完整保留，聚合查询不受清理影响（与 `usage_daily_rollups` 一致）。

## v11 联合索引迁移（已实现，幂等，2026-08-29）

- 单条 `CREATE INDEX IF NOT EXISTS idx_usage_records_model_created ON usage_records(model, created_at)`；`CREATE INDEX IF NOT EXISTS` 保证 `user_version` 回拨重放安全，仅一次 `fsync`。
- 动机：`getDailyModelBreakdown` 的回退明细路径需按 `model IN (...) AND created_at BETWEEN ? AND ? GROUP BY date, model` 扫描，`model + created_at` 联合索引提升范围过滤效率；`canUseRollups` 为真时的主路径已走 `usage_daily_rollups` 预聚合（见下方），该索引主要兜底带 `status/project/sessionId/keyword` 的回退明细路径。
- 与本次查询快路径的关系：2026-08-29 同步接入 `usage_daily_rollups` 预聚合快路径（见 [数据流](data-flow.md) 与 `usageQuery.ts:queryDailyModelRows`），无维度过滤的趋势/仪表盘查询不再触及明细表；该索引与快路径互为补充——快路径覆盖高频无过滤查询，索引覆盖带维度过滤的回退路径。

## 小时聚合物化表结构（usage_hourly_rollups，v10 新增）

```sql
CREATE TABLE usage_hourly_rollups (
  date                  TEXT    NOT NULL,
  hour                  INTEGER NOT NULL,
  app_type              TEXT    NOT NULL,  -- 插件 id：claude/codex/opencode/gemini/grok/pi/zcode/dsh
  model                 TEXT    NOT NULL,
  request_count         INTEGER NOT NULL DEFAULT 0,
  success_count         INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              TEXT    NOT NULL DEFAULT '0',
  latency_ms_total      INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, hour, app_type, model)
);
CREATE INDEX idx_usage_hourly_rollups_date ON usage_hourly_rollups (date, app_type);
```

## 明细表结构（usage_records，已实现，v8 起含失败列）

```sql
-- 主键/去重 key = id = data_source:file_path:line  （':' 分隔避免拼接歧义）
CREATE TABLE usage_records (
  id                    TEXT    NOT NULL PRIMARY KEY,
  data_source           TEXT    NOT NULL,
  app_type              TEXT    NOT NULL,  -- 插件 id：claude/codex/opencode/gemini/grok/pi/zcode/dsh
  model                 TEXT    NOT NULL,  -- 归一化后模型 ID（计费用）
  raw_model             TEXT,               -- 日志原始模型名
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  input_semantics       INTEGER NOT NULL DEFAULT 0, -- 0=未知 / 1=含缓存总量需扣减 / 2=纯新输入
  cost_usd              TEXT,               -- 字符串避免浮点误差，聚合时转微美元累加
  currency              TEXT,
  latency_ms            INTEGER,
  project               TEXT,               -- 会话归属（可选）
  session_id            TEXT,               -- 会话归属（可选）
  status                TEXT    NOT NULL DEFAULT 'success', -- 'success' | 'error'
  http_status           INTEGER,            -- v8 新增：HTTP 状态码，仅 error 有效，成功/中断为 NULL，存量 NULL
  error_message         TEXT,               -- v8 新增：截断后错误文案≤500 字符，仅 error 有效，存储层 slice(0,500)
  file_path             TEXT    NOT NULL,
  line                  INTEGER NOT NULL,
  created_at            INTEGER NOT NULL   -- epoch ms
);
CREATE INDEX idx_usage_records_created_at ON usage_records (created_at);
CREATE INDEX idx_usage_records_app_created ON usage_records (app_type, created_at);
-- v7 部分索引（WHERE 与候选查询一致，见 v7 节）
-- http_status / error_message 不建独立索引（选择性低、失败占比极低，复用时间索引范围扫描）
```

## 明细表要点

- `app_type` 直接区分监控对象（插件 id）：`claude / codex / opencode / gemini / grok / pi / zcode / dsh`（8 个内置插件阶段，无 provider 维度）。
- `data_source` 与插件 id 对应，标识数据来源插件。
- `model` 为归一化后模型 ID（计费用）；`raw_model` 保留日志原始名。
- `input_semantics`（SSOT 三态）：**0=未知 / 1=input 为含缓存读写的总量（计费前需扣减缓存）/ 2=input 已为纯新输入**。八源实际取值：claude=2、codex=1、opencode=2（上游已自行扣减）、gemini=1、grok=1、pi=2、zcode=1、dsh=2；费用侧按此扣减，见 [定价与费用](pricing.md)。
- 费用精度：`cost_usd` 以字符串存储避免浮点误差，聚合时统一转为整数微美元累加再回写字符串。
- `project` / `session_id` 记录会话归属（可选）。
- `status` 三态语义（v1 起列，v8 起失败可观测）：
  - `'success'`（默认，缺省即 success）：正常完成，已计费或零成本但成功；
  - `'error'`：失败（判定详见 `shared/failure.ts` 的 `isIgnoredFailureReason` / `IGNORED_FAILURE_STATUSES` 与 `shared/dto.ts` 的 `UsageRecord` / `RequestStatus` 类型；代码注释已于 2026-08-28 全部移除，知识库为唯一事实来源，亦见 [监控插件](monitor-plugins.md) 失败判定表）；仅此时 `http_status` / `error_message` 有效；
  - 中断忽略（`cancelled` / `interrupted`，大小写不敏感，`shared/failure.ts:IGNORED_FAILURE_STATUSES`）：**不计 error**——插件层判定为中断即不产出 error 记录，亦不触发失败告警；`status` 保持缺省 success（不单独建 `'cancelled'` 状态），`http_status`/`error_message` 保持 `NULL`（见 `shared/failure.ts:isIgnoredFailureReason`）。
- `http_status`（`INTEGER`，可空，仅失败有效）：HTTP 状态码（如 429/500/529 等）；成功/中断/存量为 `NULL`；由各插件按源提取（claude `apiErrorStatus`、zcode `error_code`、其余宽松探测），失败时宽松取首个有限数字（含字符串数字兼容），无精确码则不设（保持 `NULL`）。
- `error_message`（`TEXT`，可空，仅失败有效）：截断后的错误文案，**最长 500 字符**（`shared/failure.ts:ERROR_MESSAGE_MAX_LENGTH=500`，`storage.ts:toUsageRecordRow` 入库前 `slice(0,500)`，DTO 层不限长）；成功/中断/存量为 `NULL`；由插件按源提取（见失败判定表），表格内预览截断 64 字符、详情抽屉完整展示。
- `source.requestId`（dto 层可选字段）：稳定语义请求 ID（如上游消息 UUID），入库时写入 `dedup_ledger` 用于跨文件/重写场景去重；不单独建列。

## 去重账本（dedup_ledger，已接入）

- 写入时机：`storage.recordUsage` 入库事务内——明细 INSERT 成功且记录携带 `requestId` 时回填 `(data_source, request_id, semantic_id, created_at)`；同事务先查后写保证原子。
- 判定：下一轮同步遇到相同 `(data_source, request_id)` 直接跳过（不入明细、不计 rollup、不计 addedRecords）；覆盖「同一逻辑请求出现在不同 file_path/line」的 fork/rewrite 场景。
- `semantic_id` 为 sha256 指纹前 16 位（仅存证，当前判定按 request_id 直配）；无 requestId 的记录退回主键去重，不写账本。

## 保留策略（已接线）

- 默认 **90 天**（`retentionDays=90`，可在设置中修改），清理只删 `usage_records` 明细，**rollups 永不清理**；`retentionDays <= 0` 视为不清理。
- 清理调度已由宿主 `host.ts` 接线：启动延迟 45s 执行一次（`RETENTION_SWEEP_DELAY_MS`，2026-08-26 由 30s 上调以错开 30s 处触发的存量费用重算），并经 scheduler 以 `syncIntervalMs` 同间隔周期执行——`SchedulerService.schedule` 第三参 `initialDelayMs` 错相半个周期点火（首触到点立即执行一次再进周期）；设置变更联动重启调度，dispose 可逆。
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
