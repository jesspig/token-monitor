---
type: sync-design
title: 同步与去重
description: 增量游标 + mtime 短路 + chokidar 定向监听 + 定时兜底扫描；主键幂等去重 + fork/rewrite 语义去重账本（requestId 直配）；清理前预回填。
tags: [sync, dedup, cursor, mtime-shortcut, chokidar, watcher]
resource: src/main/services/storage.ts
timestamp: 2026-08-26T03:21:00+08:00
---

# 同步与去重

> [!note] 当前状态
> **已实现**（2026-08-20）。游标/去重落地于 `storage.ts`，调度与监听于 `scheduler.ts`/`watcher.ts`，采集编排于 `collector.ts`；语义去重账本接入、opencode WAL mtime 感知与清理前预回填于 2026-08-23 落地；mtime 短路与 watcher 定向同步、启动错峰于 2026-08-24 落地（主进程事件循环防阻塞性能优化）；**dsh zstd 字节游标（v6）与 truncate 判定收紧、首轮采集延迟 1500ms 于 2026-08-26 落地**；**同日防阻塞第二轮——外部 SQLite 只读连接 busy 短超时、调度 initialDelayMs 错相（retention sweep 45s 启动）、getPluginStatus 5s TTL 缓存、渲染端轮询收窄与失效改 1.5s 防抖**。

## 同步策略（已实现）

- **首次**：全量扫描 → 游标记录行数（opencode db 源为 `time_created` 水位）。
- **增量**：从 `line_offset` 续读；`setCursor` 时发现 `mtime` 变化（文件被 truncate/替换）→ 游标重置 0 全量重读。opencode db 源的条目 mtime 取主库与 `-wal` 文件的较大值（SQLite WAL 模式下新写入先落 `-wal`，仅看主库会漏检）。truncate 判定收紧（2026-08-26）：既有 `file_mtime = 0`（插件占位值，stat 失败兜底）不参与变化判定，避免「插件先写游标占位、采集器随后带真实 mtime 推进」的正常路径被误判为 truncate 而整文件重析。
- **字节游标（v6，2026-08-26）**：`sync_cursors` 增可空列 `byte_offset`，供 dsh `.jsonl.zstd` 工件记录「已安全消费到的压缩字节偏移」，续读只解压新增帧。`setCursor(filePath, line, fileMtime?, byteOffset?)` 语义：缺省保留现值、显式传入（含 null）覆盖、truncate 重置时行号与 byte_offset 一并清空；upsert 单语句实现（@keep_byte_offset / @reset_cursor 控制位）。NULL/非法偏移一律回退整块解压自愈，帧级增量解压细节见 [监控插件](monitor-plugins.md)。
- **mtime 短路（已实现）**：采集器每轮先经 `storage.getCursorMeta` 读游标行的 `{lineOffset, fileMtime}`，与列出文件的 mtime **一致且均非 0** 时直接跳过该文件（不解析、不计费、不入库、不推游标）；mtime 为 0（stat 失败兜底值）时不短路，保守照常解析。消除「零变更文件也全量解析」的重复开销（dsh zstd 整文件解压为主要受益者）。
  - 已知风险与自愈：短路假设「游标位置即已解析完」，若适配器早期版本**零产出却推进了游标**（脏游标），短路会永久挡住重析。dsh 初版即触发此问题，由数据库 v5 迁移清除 dsh 会话文件游标兜底——清游标后该文件按「首次」路径全量重析，重放安全靠主键幂等 + dedup_ledger 收敛保证（见 [数据模型](data-model.md) v5 迁移）。
- **触发**：
  - 插件装载时把会话目录注册进 watcher（chokidar），文件变更**只定向触发对应插件的 `collector.syncPlugin(id)`**（**500ms 防抖**合并高频事件；不再全量扫描其余插件）；
  - 定时兜底扫描（默认 **5 分钟**，`syncIntervalMs=300000` 可在设置中调整，修改后即时重启扫描）仍走全量 `syncAll()`；
  - 首轮采集错峰（2026-08-26）：启动时**不再立即全量同步**——生产入口在「窗口 show 且宿主就绪（`host.ready`）」后经 `collector.start(intervalMs, { initialSyncDelayMs: 1500 })` 延迟触发首轮采集，窗口渲染与插件装载先行，周期兜底扫描不变；
   - 启动期非关键任务错峰——models.dev 定价同步延迟 10s、零成本回填延迟 20s、存量费用重算延迟 30s、过期保留清理（retention sweep）延迟 45s 触发首次清理（`RETENTION_SWEEP_DELAY_MS`，2026-08-26 由 30s 上调以错开 30s 处的存量费用重算），避免相互争抢 IO，dispose 时清理全部延迟句柄。

## 主进程防阻塞配套（2026-08-26 第二轮）

- **调度错相**：`SchedulerService.schedule(intervalMs, task, initialDelayMs?)` 增加可选第三参——首触到点立即执行一次再进周期，缺省 = intervalMs 与原 `setInterval` 语义一致。宿主过期清理调度经此错相半个周期点火（`RETENTION_SWEEP_PHASE_OFFSET_RATIO = 0.5`），与兜底扫描等主进程重活错开执行窗口。
- **外部 SQLite 只读连接 busy 短超时**：opencode / zcode 插件打开上游 SQLite 库统一传 `EXTERNAL_DB_BUSY_TIMEOUT_MS = 250`——better-sqlite3 撞锁时在主线程同步忙等，默认 5000ms 会冻结整个应用；现撞锁约 250ms 即放弃本轮（返回空结果），由下轮兜底重试。
- **状态查询 TTL 缓存**：`collector.getPluginStatus` 结果带 5s TTL 缓存（`STATUS_CACHE_TTL_MS = 5000`），监控源页高频拉取不再每轮对全部插件做 detect/版本探测；`invalidateStatusCache()` 供主动失效，`plugins:set-enabled` IPC 处理后即调（启停立即反映）。

## 去重策略（已实现，双层）

1. **主键去重**：记录 id = `data_source:file_path:line`（`:` 分隔），入库用 `INSERT OR IGNORE`；命中即跳过，且**不累计**进日聚合。
2. **语义去重（fork/rewrite 场景）**：五插件均产出稳定 `source.requestId`——claude=message.id、codex=`threadId:行timestamp:in-cached-out` 组合键、opencode=db 行主键 id（旧版 JSON 为 data.id）、gemini=消息 UUID、grok=`sid:loop_index`。`recordUsage` 事务内按 `(data_source, request_id)` 查 `dedup_ledger`，命中即跳过（不入明细、不计 rollup、不计 addedRecords、不触发 usage-updated）；插入成功回填账本（见 [数据模型](data-model.md)）。无 requestId 的记录退回主键去重。
3. 入库前另有一道数据质量闸门：解析产物中 input / output / cache_read / cache_creation **四项全 0** 的记录被 `collector.isAllZeroUsage` 统一拦截不入库（游标仍按 nextLine 正常推进），避免空转请求污染明细与聚合；存量同类脏数据由 v3 迁移一次性清洗（见 [数据模型](data-model.md)）。
4. opencode 新版 db 源的 line 由 `time_created` 水位派生并严格递增，保证跨轮唯一。

## 实时刷新（已实现）

- 一轮同步实际新增记录数 > 0 才发 `usage-updated` 事件（EventBus **200ms 防抖**窗口内合并，addedRecords 累加；语义去重命中不计入新增），经 IPC 推送前端。
- 渲染端 `hooks/useUsageEvents.ts` 订阅该事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），由 TanStack Query 自动重新拉取；失效合并策略为 **1500ms 防抖**（`INVALIDATE_DEBOUNCE_MS`，2026-08-26 由 1000ms 冷却节流改防抖——CLI 活跃期事件流安静 1.5s 后合并失效一次）。兜底轮询已收窄（2026-08-26）：QueryClient 全局默认 `refetchInterval` 移除，仅用量类查询显式轮询并读取设置项 `statsRefreshIntervalMs`（默认 30000ms），实时性由推送保证；其余细节见 [UI 页面](ui-pages.md)。

## 关联页面

- [监控插件](monitor-plugins.md) — parseFile 的游标推进与各插件 requestId 组装规则。
- [数据模型](data-model.md) — `sync_cursors` / `dedup_ledger` 表。
- [数据流](data-flow.md) — 机制 1/2/3/7 的位置。
- [返回目录](../index.md)
