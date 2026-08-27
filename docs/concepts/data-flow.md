---
type: architecture
title: 数据流
description: 会话日志经插件增量解析、失败零 token 放行、双层去重、按输入语义计费后写入明细与日聚合（error_count），再供前端查询与错误可观测展示。
tags: [data-flow, pipeline, usage, sqlite, plugin, failure-observability]
resource: src/main/collector.ts
timestamp: 2026-08-28T02:27:00+08:00
---

# 数据流

> [!note] 当前状态
> **已实现**（2026-08-20）。数据链路落地于 `src/main`：collector.ts 采集 → storage.ts 入库/rollup → usageQuery.ts 查询 → EventBus 推送。语义去重与计费语义修复于 2026-08-23 接入；**2026-08-26：计费循环改批量（calcCostBatch）、查询侧语句预编译缓存、dsh zstd 帧级增量解压**；**2026-08-27：失败可观测性全链路——8 插件失败判定产出 status=error + http_status/error_message → collector 零 token 放行 → storage 持久化 + rollup error_count 增量 → usageQuery 筛选回退明细表 → 前端错误列与抽屉展示（存量由 v9 全量清游标回溯）**；**同日：小时聚合物化（v10，`usage_hourly_rollups` 与日聚合镜像同事务增量维护，小时查询无筛选维度读该表、带维度回退明细全扫）、统计查询 offload 到只读 worker 线程（WAL 共享同一 DB，主线程不再被 better-sqlite3 阻塞）、系统托盘后台常驻（关窗隐藏不退出，见 [总体架构](architecture.md)）**。

## 端到端链路

```
CLI 会话文件(JSONL / JSON / SQLite)
  → 插件增量解析(行游标 + 稳定 requestId + 失败判定 status/errorMessage/httpStatus)
  → 全零 token 记录过滤(数据质量，失败零 token 放行：status=error 豁免)
  → 去重(主键幂等 + dedup_ledger 语义去重，失败亦经同路径)
  → 费用计算(按 input_semantics 三态扣减缓存，失败零 token 计费为 0)
  → usage_records 明细（http_status / error_message 仅失败有效，存量 NULL）
   → usage_daily_rollups 日聚合镜像（recordUsage 同事务增量维护 success_count / error_count）
   → usage_hourly_rollups 小时聚合物化（同事务累桶，供按小时下钻/实时筛选优先读取）
   → 前端查询（聚合优先读 rollups / 小时读 hourly；status/project/sessionId/keyword 筛选回退明细表；查询经只读 worker 线程 offload，WAL 不阻塞主线程；事件 usage-updated 触发失效重取，由 QueryClient in-flight 去重收敛风暴）
   → 前端展示（请求日志表「错误」列 + 详情抽屉 errorMessage + 状态徽章叠加 httpStatus）
```

「插件增量解析」由各监控插件执行（见 [监控插件](monitor-plugins.md) 失败判定表）；其余环节由宿主服务承担。采集编排：`collector.syncAll()` 对每个已启用插件执行「探测 → 列文件 → **mtime 短路判定**（游标与文件 mtime 一致且均非 0 时跳过，2026-08-24 接入）→ 从游标续读 parseFile（8 插件各自失败分支产出 `status='error'`，含 `httpStatus`/`errorMessage` 宽松提取，`cancelled/interrupted` 忽略不产出）→ 过滤四项 token 全 0 的记录（`isAllZeroUsage` 对 `status='error'` 放行，`truncateErrorMessage` 入库前截断 500）→ 一次 `pricing.calcCostBatch` 批量计费并按位回填 costUsd（失败零 token 计费为 0，无定价项 undefined 跳过，2026-08-26 由逐条 await 改批）→ `storage.recordUsage` 入库（含双层去重判定：主键 + dedup_ledger，失败亦同路径，`toUsageRecordRow` 再截断 500 并直写 `http_status/error_message`，`error_count` 增量）→ 游标推进到 `nextLine`」；watcher 变更事件走 `collector.syncPlugin(id)` 只定向同步对应插件（同日接入）。dsh 插件的 `.jsonl.zstd` 工件在 parseFile 内部按**压缩字节游标做帧级增量解压**（2026-08-26，只解压新增帧而非整文件，详见 [监控插件](monitor-plugins.md) 与 [同步与去重](sync-mechanism.md)）。**存量回溯**：v9 迁移 `DELETE FROM sync_cursors` 清空游标触发全量重析（见 [数据模型](data-model.md) v9 与 [同步与去重](sync-mechanism.md) 失败存量回溯），重放由双层幂等保证不重复计数。

**查询侧**：`usageQuery.ts` 全部聚合类查询（汇总/日趋势/按模型/按应用）优先读 `usage_daily_rollups` 镜像，筛选含 `status`/`httpStatus|statusCode`/`project`/`sessionId`/`keyword` 时回退明细表（`status='error'` 或 `httpStatus=429` 等在明细表以 `WHERE status=? AND http_status=?` 精确过滤，复用 v10 新增的 `idx_usage_records_status` / `idx_usage_records_project` / `idx_usage_records_session_id` 单列索引与时间索引范围扫描；rollup 无 `http_status` 列，下推会丢条件，见 `canUseRollups`）；明细分页与详情始终查明细表（`toDetail` 映射 `http_status/error_message → httpStatus/errorMessage`），today 与 24h 范围的小时桶经 `getHourlyTrends` 底层 `queryHourlyRows` 读取——**无筛选维度时优先读 `usage_hourly_rollups` 物化小表**（按 `date BETWEEN` 取候选 + 可选 appTypes/models 过滤 + 精确时间窗裁剪），**带 status/project/sessionId/keyword 时回退 `usage_records` 全扫**（GROUP BY `day_key, hour`）；其余范围走天聚合。**过滤语义**：`status='error'` 仅返回失败记录；`httpStatus`/`statusCode` 为同义别名（优先 `httpStatus`），仅对失败记录有效，成功/中断为 `NULL`；`cancelled/interrupted` 不计 error，筛选不返回。**查询执行线程**：`host.usageQuery` 已是 `QueryClient`（`worker/queryClient.ts`），文件库模式下把查询 offload 到 `workers/query-worker.ts` 只读 worker 线程（WAL 下读已提交快照，不阻塞主线程写者）；`:memory:` 或 worker 启动失败时回退主进程直查；相同 `(method+args)` 的并发请求由 QueryClient 做 in-flight 去重，收敛 `usage-updated` 事件批量失效重取风暴。

## 关键机制（核心设计）

1. **增量同步**：`sync_cursors` 记录每文件 `mtime + 行偏移`，只解析新增行；mtime 变化（truncate/替换）时游标重置为 0 重读；**mtime 未变且均非 0 时整文件短路跳过（2026-08-24）**；opencode db 源 mtime 取主库与 `-wal` 较大值。dsh zstd 工件另有可空 `byte_offset` 压缩字节游标（v6，2026-08-26）：续读仅解压新增帧，偏移非法/坏帧回退整块解压自愈。脏游标（旧适配器零产出却推进游标）会被短路永久跳过，自愈路径 = 迁移清游标触发全量重析（v5 dsh 案例；**v9 失败存量回溯亦同理全量清游标**），重放安全由双层幂等（主键 + dedup_ledger）保证。
2. **双层去重**：主键幂等——记录 id = `data_source:file_path:line`，`INSERT OR IGNORE`；fork/rewrite 语义去重——插件产出的 `source.requestId` 经 `dedup_ledger` 按 `(data_source, request_id)` 判重，命中即跳过且不累计聚合（失败记录亦同路径，`semantic_id` 相同不误合并，见 [同步与去重](sync-mechanism.md)）。
3. **Token 语义归一化**：`input_semantics`（0=未知 / 1=含缓存总量需扣减 / 2=纯新输入）；费用计算按语义先扣缓存再乘价。
4. **模型 ID 归一化**：8 步清洗（前缀、冒号、[1m]、@、包装前缀、日期/版本后缀、effort 后缀）+ 五级匹配兜底链，见 [定价与费用](pricing.md)。
5. **全零过滤与费用计算（含失败放行）**：入库前统一拦截 inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens **四项全 0** 的记录（`isAllZeroUsage`，不入库，游标仍按 nextLine 正常推进）；**失败例外（2026-08-27）**：`status='error'` 时即使四项全 0 亦放行（`isAllZeroUsage` 首行 `status==='error' → false`），`truncateErrorMessage` 对失败文案截断 500 后再计费；其余记录按定价表 + 可配置 cost multiplier 计费——`syncOne` 对单文件记录一次调用 `pricing.calcCostBatch`（单次取定价索引后同步逐条计算）并按位回填，无定价项 costUsd 保持空（失败零 token 计费为 0，2026-08-26 批量化，语义与逐条 calcCost 完全一致）。
6. **日聚合（含 error_count）与小时聚合**：入库同事务按 `(date, app_type, model)` 桶累加 upsert（`recordUsage` 实时维护镜像），并**同步按 `(date, hour, app_type, model)` 累桶维护 `usage_hourly_rollups`**（v10 新增，与日桶口径一致）；`success_count` / `error_count` 按 `status` 分桶累加（`status==='error'` 则 `errorCount++`，否则 `successCount++`），token/cost/latency 同步累加；费用以微美元整数精度累加后回写字符串；明细可裁剪（prune），历史趋势由 rollups 镜像保证（日/小时表均永不清理）；`status`/`httpStatus`/`project`/`sessionId` 筛选回退明细表，不经 rollups（rollup 无对应维度列，v10 起明细有 `status`/`project`/`session_id` 单列索引）。
7. **实时刷新**：新增记录数 > 0 才发 `usage-updated`（200ms 防抖合并，`addedRecords` 含失败新增，语义去重命中不计入），渲染端 `useUsageEvents` 订阅后失效 6 个用量 queryKey 触发重拉；**重取风暴由 QueryClient in-flight 去重收敛**——相同 `(method+args)` 的并发查询只发一次 worker 请求，多个失效订阅共享同一 Promise。
8. **零成本回填与存量重算**：`pricing.backfillZeroCost` 重算 `cost=0/null` 明细并增量修正 rollup 费用（应用启动延迟 20s、每次 models.dev 全量同步触发）；`pricing.recalcCachedInputCosts` 以新计费公式按活定价重算 codex/gemini/grok 存量高估行（宿主启动延迟 30s 触发，幂等）；保留清理前也先尽力回填，防止缺价明细到期删除后永久无法回补。启动期三类重活与首轮采集错峰执行（10s/20s/30s，2026-08-24）。
9. **失败可观测性全链路（2026-08-27，T01 矩阵）**：8 插件按各自判定产出 `status='error'` + `httpStatus`/`errorMessage`（见 [监控插件](monitor-plugins.md) 失败判定表，`shared/failure.ts` 的 `isIgnoredFailureReason` / `IGNORED_FAILURE_STATUSES` / `ERROR_MESSAGE_MAX_LENGTH` 为唯一 SSOT；代码注释已于 2026-08-28 全部移除，知识库为唯一事实来源；`cancelled/interrupted` 忽略）→ `collector` 对失败放行全零并截断 500 → `storage` 持久化 `http_status/error_message`（`toUsageRecordRow` 直写，`recordUsage` 增量 `error_count`）→ `usageQuery` 失败筛选回退明细表（`status`/`httpStatus|statusCode`，复用时间索引，见 `usageQuery.ts` 的 `buildWhere` 函数实现）→ 前端请求日志「错误」列（`httpStatus` 徽章 + `errorMessage` 预览截断 64，`title` 悬停完整）与详情抽屉「错误信息」区完整展示；存量失败由 v9 `DELETE FROM sync_cursors` 全量重析回填，幂等重放保证见 [同步与去重](sync-mechanism.md) 失败存量回溯。
10. **统计查询 offload 到 worker 线程（2026-08-27）**：`usageQuery` 在文件库模式下经 `worker/queryClient.ts` 把全部聚合/明细查询转发给 `workers/query-worker.ts` 只读 worker 线程；worker 持独立 `better-sqlite3` 只读连接（WAL 下读已提交快照），主线程不再因同步 `better-sqlite3` 查询被阻塞；`:memory:` / worker 启动失败回退主进程直查（仍走同一 `createUsageQuery`，仅失线程隔离）；退出经 `before-quit` 调 `queryClient.terminate()` 终止 worker。

## 关联页面

- [插件体系](plugin-architecture.md) — 数据更新如何经事件总线推送。
- [总体架构](architecture.md) — 各环节归属的模块。
- [数据模型](data-model.md) — 明细/聚合表结构。
- [同步与去重](sync-mechanism.md) — 机制 1/2/3/7 的细节。
- [返回目录](../index.md)
