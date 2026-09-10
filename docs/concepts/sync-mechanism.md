---
type: sync-design
title: 同步与去重
description: 增量游标 + mtime 短路 + chokidar 定向监听 + 定时兜底扫描；插件级有界并发 + dsh 异步列举；主键幂等去重 + fork/rewrite 语义去重账本；失败零 token 放行与存量回溯 v9 全量清游标幂等重放；清理前预回填。
tags: [sync, dedup, cursor, mtime-shortcut, chokidar, watcher, failure-observability, concurrency]
resource: src/main/services/storage.ts
timestamp: 2026-09-10T20:51:01+08:00
---

# 同步与去重

> [!note] 当前状态
> **已实现**（2026-08-20）。游标/去重落地于 `storage.ts`，调度与监听于 `scheduler.ts`/`watcher.ts`，采集编排于 `collector.ts`；语义去重账本接入、opencode WAL mtime 感知与清理前预回填于 2026-08-23 落地；mtime 短路与 watcher 定向同步、启动错峰于 2026-08-24 落地（主进程事件循环防阻塞性能优化）；**dsh zstd 字节游标（v6）与 truncate 判定收紧、首轮采集延迟 1500ms 于 2026-08-26 落地**；**同日防阻塞第二轮——外部 SQLite 只读连接 busy 短超时、调度 initialDelayMs 错相（retention sweep 45s 启动）、getPluginStatus 5s TTL 缓存、渲染端轮询收窄与失效改 1.5s 防抖**；**2026-08-27 失败可观测性——失败零 token 放行（isAllZeroUsage 对 status=error 豁免）与存量回溯 v9 全量清游标幂等重放（DELETE FROM sync_cursors，见下方）**。**2026-08-28 并发与异步化**：`collector.syncAll` 改插件级有界并发（`SYNC_CONCURRENCY=4`，分批 `Promise.all`，文件级仍串行保事务），`dsh.listFiles` 目录列举改 `fs.promises.readdir/stat` 异步，`detect` 探测链路保留同步；`queryClient` 池化见 [总体架构](architecture.md)。

## 同步策略（已实现）

- **首次**：全量扫描 → 游标记录行数（opencode db 源为 `time_created` 水位）。
- **增量**：从 `line_offset` 续读；`setCursor` 时发现 `mtime` 变化（文件被 truncate/替换）→ 游标重置 0 全量重读。opencode db 源的条目 mtime 取主库与 `-wal` 文件的较大值（SQLite WAL 模式下新写入先落 `-wal`，仅看主库会漏检）。truncate 判定收紧（2026-08-26）：既有 `file_mtime = 0`（插件占位值，stat 失败兜底）不参与变化判定，避免「插件先写游标占位、采集器随后带真实 mtime 推进」的正常路径被误判为 truncate 而整文件重析。
- **字节游标（v6，2026-08-26）**：`sync_cursors` 增可空列 `byte_offset`，供 dsh `.jsonl.zstd` 工件记录「已安全消费到的压缩字节偏移」，续读只解压新增帧。`setCursor(filePath, line, fileMtime?, byteOffset?)` 语义：缺省保留现值、显式传入（含 null）覆盖、truncate 重置时行号与 byte_offset 一并清空；upsert 单语句实现（@keep_byte_offset / @reset_cursor 控制位）。NULL/非法偏移一律回退整块解压自愈，帧级增量解压细节见 [监控插件](monitor-plugins.md)。
- **mtime 短路（已实现）**：采集器每轮先经 `storage.getCursorMeta` 读游标行的 `{lineOffset, fileMtime}`，与列出文件的 mtime **一致且均非 0** 时直接跳过该文件（不解析、不计费、不入库、不推游标）；mtime 为 0（stat 失败兜底值）时不短路，保守照常解析。消除「零变更文件也全量解析」的重复开销（dsh zstd 整文件解压为主要受益者）。
  - 已知风险与自愈：短路假设「游标位置即已解析完」，若适配器早期版本**零产出却推进了游标**（脏游标），短路会永久挡住重析。dsh 初版即触发此问题，由数据库 v5 迁移清除 dsh 会话文件游标兜底；**2026-08-27 失败可观测性接入前（v8 前无失败列且全零拦截未对 error 放行）历史失败已属同类脏游标——由 v9 迁移 `DELETE FROM sync_cursors` 全量清游标自愈（见 [数据模型](data-model.md) v9），清游标后按「首次」路径全量重析，重放安全靠双层幂等保证（见下方「去重策略」第 5 点与「失败存量回溯」）**。
- **触发**：
  - 插件装载时把会话目录注册进 watcher（chokidar），文件变更**只定向触发对应插件的 `collector.syncPlugin(id)`**（**500ms 防抖**合并高频事件；不再全量扫描其余插件）；
  - 定时兜底扫描（默认 **5 分钟**，`syncIntervalMs=300000` 可在设置中调整，修改后即时重启扫描）仍走全量 `syncAll()`；
  - 首轮采集错峰（2026-08-26）：启动时**不再立即全量同步**——生产入口在「窗口 show 且宿主就绪（`host.ready`）」后经 `collector.start(intervalMs, { initialSyncDelayMs: 1500 })` 延迟触发首轮采集，窗口渲染与插件装载先行，周期兜底扫描不变；
   - 启动期非关键任务错峰——models.dev 定价同步延迟 10s、零成本回填延迟 20s、存量费用重算延迟 30s、过期保留清理（retention sweep）延迟 45s 触发首次清理（`RETENTION_SWEEP_DELAY_MS`，2026-08-26 由 30s 上调以错开 30s 处的存量费用重算），避免相互争抢 IO，dispose 时清理全部延迟句柄。

## 主进程防阻塞配套（2026-08-26 第二轮）

- **调度错相**：`SchedulerService.schedule(intervalMs, task, initialDelayMs?)` 增加可选第三参——首触到点立即执行一次再进周期，缺省 = intervalMs 与原 `setInterval` 语义一致。宿主过期清理调度经此错相半个周期点火（`RETENTION_SWEEP_PHASE_OFFSET_RATIO = 0.5`），与兜底扫描等主进程重活错开执行窗口。
- **外部 SQLite 只读连接 busy 短超时**：opencode / zcode / zed 插件打开上游 SQLite 库统一传 `EXTERNAL_DB_BUSY_TIMEOUT_MS = 250`（zed 为文件内常量），qoder / qoder-cn 经 `_lib/qoder-shared.ts` 传 `QODER_DB_BUSY_TIMEOUT_MS = 250`——better-sqlite3 撞锁时在主线程同步忙等，默认 5000ms 会冻结整个应用；现撞锁约 250ms 即放弃本轮（返回空结果），由下轮兜底重试。
- **状态查询 TTL 缓存**：`collector.getPluginStatus` 结果带 5s TTL 缓存（`STATUS_CACHE_TTL_MS = 5000`），监控源页高频拉取不再每轮对全部插件做 detect/版本探测；`invalidateStatusCache()` 供主动失效，`plugins:set-enabled` IPC 处理后即调（启停立即反映）。

## 去重策略（已实现，双层 + 失败放行）

1. **主键去重**：记录 id = `data_source:file_path:line`（`:` 分隔），入库用 `INSERT OR IGNORE`；命中即跳过，且**不累计**进日聚合。v9 全量重析时已入库的成功记录因该主键冲突 `info.changes===0` 跳过，不重复累 `rollup`/`addedRecords`（见下方「失败存量回溯」）。
2. **语义去重（fork/rewrite 场景）**：22 插件中 20 个产出稳定 `source.requestId`（第二批 14 源中 12 源产出；kimi 与 reasonix 例外，退回主键去重）——claude=`message.id`/`uuid`、codex=`threadId:行timestamp:in-cached-out` / stream_error 无 id（退回主键）、opencode=`db 行主键 id`（`SELECT m.*` 兼容 `message.id` 回退）、gemini=消息 `id`、grok=`sid:loop_index` 全量重析、pi/zcode/dsh 及第二批各源的逐源规则见 [监控插件](monitor-plugins.md)。`recordUsage` 事务内按 `(data_source, request_id)` 查 `dedup_ledger`（`SELECT ... WHERE data_source=? AND request_id=?`），命中即跳过（不入明细、不计 rollup、不计 addedRecords、不触发 usage-updated）；插入成功回填账本 `semantic_id=sha256 前 16 位`（仅存证，判定按 `request_id` 直配）；失败记录常零 token，其 `semantic_id` 可能相同但**不参与判定**，主路径仍以 `(data_source, request_id)` 为准，不会误合并。无 requestId 的记录退回主键去重。
3. 入库前另有一道数据质量闸门：解析产物中 input / output / cache_read / cache_creation **四项全 0** 的记录被 `collector.isAllZeroUsage` 统一拦截不入库（游标仍按 nextLine 正常推进），避免空转请求污染明细与聚合；**失败例外（2026-08-27）**：`status==='error'` 的记录即使四项全 0 亦**放行**（`isAllZeroUsage` 判定首行 `if (record.status==='error') return false`，依据 `shared/failure.ts` 的 `IGNORED_FAILURE_STATUSES` / `isIgnoredFailureReason` 常量与代码实现；代码注释已于 2026-08-28 全部移除，知识库为唯一事实来源），保证零 token 失败可观测；`cancelled/interrupted` 属中断忽略由插件层不产 error 本闸门不涉；存量同类脏数据由 v3 迁移一次性清洗（见 [数据模型](data-model.md) v3）。
4. 失败文案截断：`collector.truncateErrorMessage` 对 `status='error'` 记录的 `errorMessage` 入库前再做 `slice(0,500)`（`shared/failure.ts:ERROR_MESSAGE_MAX_LENGTH`），DTO 层不限长，存储层 `toUsageRecordRow` 亦二次截断，双层收敛；成功记录零开销。
5. opencode 新版 db 源的 line 由 `time_created` 水位派生并严格递增，保证跨轮唯一。

## 失败存量回溯（v9，已实现，幂等）

- **背景**：v8 前无 `http_status`/`error_message` 列且 `collector.isAllZeroUsage` 对失败未豁免，历史失败请求从未入库；但其会话文件的游标已推进到末尾，且 `mtime` 短路会挡住增量重析，导致历史失败永不回填。
- **自愈入口**：`db.ts` v9 迁移执行 `DELETE FROM sync_cursors` 全量清游标（而非 `data_source IN (...)` 或 `LIKE` 过滤——失败横跨 8 插件且早期 `data_source` 可能为空字符串，过滤会漏删，全量更稳且幂等 `DELETE` 重复执行无影响），由 `migrate()` 外层 `db.transaction` 包裹 `m.up + PRAGMA user_version` 单事务仅一次 `fsync`；清游标后下一轮 `collector.syncAll` 对全部文件按「首次」路径全量解析，失败分支与成功分支同批产出。
- **幂等重放保证**：双层 `INSERT OR IGNORE`——`usage_records` 主键 `id` + `dedup_ledger` 主键 `(data_source, request_id)`（均与 `recordUsage` 同事务）。已入库的成功记录因主键冲突 `info.changes===0` 跳过（不累 `rollup.error_count`/`addedRecords`，不触发 `usage-updated`）；仅新增的失败记录正常入库且增量修正 `usage_daily_rollups.error_count`（`storage.ts` 按 `r.status==='error'` 累 `errorCount`），`dedup_ledger` 同步收敛。稳态一轮后游标即重建，后续增量仍走 mtime 短路，开销仅首轮一次全量解析。
- **与 v5 的关系**：v5 为 dsh 单源脏游标定向清理（`LIKE '%\.dsh\sessions%'`），v9 为跨 8 插件的全量存量回溯；两者皆靠双层幂等保证重放安全，仅 `DELETE` 作用域不同。

## 实时刷新（已实现）

- 一轮同步实际新增记录数 > 0 才发 `usage-updated` 事件（EventBus **200ms 防抖**窗口内合并，addedRecords 累加；语义去重命中不计入新增），经 IPC 推送前端。
- 渲染端 `hooks/useUsageEvents.ts` 订阅该事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），由 TanStack Query 自动重新拉取；失效合并策略为 **1500ms 防抖**（`INVALIDATE_DEBOUNCE_MS`，2026-08-26 由 1000ms 冷却节流改防抖——CLI 活跃期事件流安静 1.5s 后合并失效一次）。兜底轮询已收窄（2026-08-26）：QueryClient 全局默认 `refetchInterval` 移除，仅用量类查询显式轮询并读取设置项 `statsRefreshIntervalMs`（默认 30000ms），实时性由推送保证；其余细节见 [UI 页面](ui-pages.md)。

## 关联页面

- [监控插件](monitor-plugins.md) — parseFile 的游标推进与各插件 requestId 组装规则。
- [数据模型](data-model.md) — `sync_cursors` / `dedup_ledger` 表。
- [数据流](data-flow.md) — 机制 1/2/3/7 的位置。
- [返回目录](../index.md)
