---
type: sync-design
title: 同步与去重
description: 增量游标 + chokidar 监听 + 定时兜底扫描；主键幂等去重，fork/rewrite 语义去重账本预留。
tags: [sync, dedup, cursor, chokidar, watcher]
resource: src/main/services/storage.ts
timestamp: 2026-08-22T18:15:00+08:00
---

# 同步与去重

> [!note] 当前状态
> **已实现**（2026-08-20）。游标/去重落地于 `storage.ts`，调度与监听于 `scheduler.ts`/`watcher.ts`，采集编排于 `collector.ts`。

## 同步策略（已实现）

- **首次**：全量扫描 → 游标记录行数（opencode db 源为 `time_created` 水位）。
- **增量**：从 `line_offset` 续读；`setCursor` 时发现 `mtime` 变化（文件被 truncate/替换）→ 游标重置 0 全量重读。
- **触发**：
  - 插件装载时把会话目录注册进 watcher（chokidar），文件变更触发同步（**500ms 防抖**合并高频事件）；
  - 定时兜底扫描（默认 **5 分钟**，`syncIntervalMs=300000` 可在设置中调整，修改后即时重启扫描）；
  - 启动时立即执行一次全量同步。

## 去重策略（已实现）

- 以记录 id = `data_source:file_path:line`（`:` 分隔）为主键，入库用 `INSERT OR IGNORE`；命中即跳过，且**不累计**进日聚合。
- 入库前另有一道数据质量闸门：解析产物中 input / output / cache_read / cache_creation **四项全 0** 的记录被 `collector.isAllZeroUsage` 统一拦截不入库（游标仍按 nextLine 正常推进），避免空转请求污染明细与聚合；存量同类脏数据由 v3 迁移一次性清洗（见 [数据模型](data-model.md)）。
- opencode 新版 db 源的 line 由 `time_created` 水位派生并严格递增，保证跨轮唯一。
- fork/rewrite 场景的语义去重（`semantic_id` 指纹）**尚未接入**：`dedup_ledger` 表与索引已在 v1 迁移建好（主键 `(data_source, request_id)`、`semantic_id` 索引），DAO 与指纹算法预留后续迭代。

> [!todo] 待补充
> semantic_id 指纹组成与 dedup_ledger 写入时机待后续迭代设计（需 fork/rewrite 真实样本验证双算/漏算平衡）。

## 实时刷新（已实现）

- 一轮同步实际新增记录数 > 0 才发 `usage-updated` 事件（EventBus **200ms 防抖**窗口内合并，addedRecords 累加），经 IPC 推送前端。
- 渲染端 `hooks/useUsageEvents.ts` 订阅该事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），由 TanStack Query 自动重新拉取；另有兜底轮询（`refetchInterval` 函数式读取设置项 `statsRefreshIntervalMs`，默认 5000ms，失焦暂停）。

## 关联页面

- [监控插件](monitor-plugins.md) — parseFile 的游标推进。
- [数据模型](data-model.md) — `sync_cursors` / `dedup_ledger` 表。
- [数据流](data-flow.md) — 机制 1/2/3/7 的位置。
- [返回目录](../index.md)
