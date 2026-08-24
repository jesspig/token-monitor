---
type: sync-design
title: 同步与去重
description: 增量游标 + mtime 短路 + chokidar 定向监听 + 定时兜底扫描；主键幂等去重 + fork/rewrite 语义去重账本（requestId 直配）；清理前预回填。
tags: [sync, dedup, cursor, mtime-shortcut, chokidar, watcher]
resource: src/main/services/storage.ts
timestamp: 2026-08-24T16:58:00+08:00
---

# 同步与去重

> [!note] 当前状态
> **已实现**（2026-08-20）。游标/去重落地于 `storage.ts`，调度与监听于 `scheduler.ts`/`watcher.ts`，采集编排于 `collector.ts`；语义去重账本接入、opencode WAL mtime 感知与清理前预回填于 2026-08-23 落地；**mtime 短路与 watcher 定向同步、启动错峰于 2026-08-24 落地（主进程事件循环防阻塞性能优化）**。

## 同步策略（已实现）

- **首次**：全量扫描 → 游标记录行数（opencode db 源为 `time_created` 水位）。
- **增量**：从 `line_offset` 续读；`setCursor` 时发现 `mtime` 变化（文件被 truncate/替换）→ 游标重置 0 全量重读。opencode db 源的条目 mtime 取主库与 `-wal` 文件的较大值（SQLite WAL 模式下新写入先落 `-wal`，仅看主库会漏检）。
- **mtime 短路（已实现）**：采集器每轮先经 `storage.getCursorMeta` 读游标行的 `{lineOffset, fileMtime}`，与列出文件的 mtime **一致且均非 0** 时直接跳过该文件（不解析、不计费、不入库、不推游标）；mtime 为 0（stat 失败兜底值）时不短路，保守照常解析。消除「零变更文件也全量解析」的重复开销（dsh zstd 整文件解压为主要受益者）。
- **触发**：
  - 插件装载时把会话目录注册进 watcher（chokidar），文件变更**只定向触发对应插件的 `collector.syncPlugin(id)`**（**500ms 防抖**合并高频事件；不再全量扫描其余插件）；
  - 定时兜底扫描（默认 **5 分钟**，`syncIntervalMs=300000` 可在设置中调整，修改后即时重启扫描）仍走全量 `syncAll()`；
  - 启动时立即执行一次全量同步；启动期非关键任务错峰——models.dev 定价同步延迟 10s、零成本回填延迟 20s、存量费用重算延迟 30s（`host.ts` 常量），避免与首轮采集同帧争抢 IO，dispose 时清理全部延迟句柄。

## 去重策略（已实现，双层）

1. **主键去重**：记录 id = `data_source:file_path:line`（`:` 分隔），入库用 `INSERT OR IGNORE`；命中即跳过，且**不累计**进日聚合。
2. **语义去重（fork/rewrite 场景）**：五插件均产出稳定 `source.requestId`——claude=message.id、codex=`threadId:行timestamp:in-cached-out` 组合键、opencode=db 行主键 id（旧版 JSON 为 data.id）、gemini=消息 UUID、grok=`sid:loop_index`。`recordUsage` 事务内按 `(data_source, request_id)` 查 `dedup_ledger`，命中即跳过（不入明细、不计 rollup、不计 addedRecords、不触发 usage-updated）；插入成功回填账本（见 [数据模型](data-model.md)）。无 requestId 的记录退回主键去重。
3. 入库前另有一道数据质量闸门：解析产物中 input / output / cache_read / cache_creation **四项全 0** 的记录被 `collector.isAllZeroUsage` 统一拦截不入库（游标仍按 nextLine 正常推进），避免空转请求污染明细与聚合；存量同类脏数据由 v3 迁移一次性清洗（见 [数据模型](data-model.md)）。
4. opencode 新版 db 源的 line 由 `time_created` 水位派生并严格递增，保证跨轮唯一。

## 实时刷新（已实现）

- 一轮同步实际新增记录数 > 0 才发 `usage-updated` 事件（EventBus **200ms 防抖**窗口内合并，addedRecords 累加；语义去重命中不计入新增），经 IPC 推送前端。
- 渲染端 `hooks/useUsageEvents.ts` 订阅该事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），由 TanStack Query 自动重新拉取；另有兜底轮询（`refetchInterval` 函数式读取设置项 `statsRefreshIntervalMs`，默认 30000ms——2026-08-24 由 5000ms 上调以降低主进程查询压力，实时性由推送保证、轮询仅兜底，失焦暂停）。

## 关联页面

- [监控插件](monitor-plugins.md) — parseFile 的游标推进与各插件 requestId 组装规则。
- [数据模型](data-model.md) — `sync_cursors` / `dedup_ledger` 表。
- [数据流](data-flow.md) — 机制 1/2/3/7 的位置。
- [返回目录](../index.md)
