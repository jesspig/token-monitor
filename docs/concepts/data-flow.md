---
type: architecture
title: 数据流
description: 会话日志经插件增量解析、去重、费用计算后写入明细与日聚合，再供前端查询。
tags: [data-flow, pipeline, usage, sqlite, plugin]
resource: src/main/collector.ts
timestamp: 2026-08-22T18:40:00+08:00
---

# 数据流

> [!note] 当前状态
> **已实现**（2026-08-20）。数据链路落地于 `src/main`：collector.ts 采集 → storage.ts 入库/rollup → usageQuery.ts 查询 → EventBus 推送。

## 端到端链路

```
CLI 会话文件(JSONL / JSON / SQLite)
  → 插件增量解析(行游标)
  → 全零 token 记录过滤(数据质量)
  → 去重(主键幂等)
  → 费用计算
  → usage_records 明细
  → usage_daily_rollups 日聚合镜像（recordUsage 同事务实时维护）
  → 前端查询（聚合优先读 rollups；事件 usage-updated 实时刷新）
```

「插件增量解析」由各监控插件执行（见 [监控插件](monitor-plugins.md)）；其余环节由宿主服务承担。采集编排：`collector.syncAll()` 对每个已启用插件执行「探测 → 列文件 → 从游标续读 parseFile → 过滤四项 token 全 0 的记录 → 逐条 `pricing.calcCost` 回填 costUsd → `storage.recordUsage` 入库 → 游标推进到 `nextLine`」。

**查询侧**：`usageQuery.ts` 全部聚合类查询（汇总/日趋势/按模型/按应用）优先读 `usage_daily_rollups` 镜像，筛选含 `status`/`project`/`sessionId`/`keyword` 时回退明细表；明细分页与详情始终查明细表。today 与 24h 范围的小时桶经 `getHourlyTrends` 按本地时区对明细 GROUP BY（day_key + hour 双维归桶，小时桶含日期维度，跨天滚动窗口不合并同钟点），不经 rollups（其余范围走天聚合）。

## 关键机制（核心设计）

1. **增量同步**：`sync_cursors` 记录每文件 `mtime + 行偏移`，只解析新增行；mtime 变化（truncate/替换）时游标重置为 0 重读。
2. **去重**：主键幂等——记录 id = `data_source:file_path:line`，`INSERT OR IGNORE`，命中即跳过且不累计聚合；`dedup_ledger` 表已建但未接入写入路径（fork/rewrite 语义去重预留）。
3. **Token 语义归一化**：`input_semantics`（0=未知 / 1=含缓存写 / 2=纯新输入）。
4. **模型 ID 归一化**：去前缀、去日期/版本后缀、`@→-`、转小写，再查定价。
5. **全零过滤与费用计算**：入库前统一拦截 inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens **四项全 0** 的记录（`isAllZeroUsage`，不入库，游标仍按 nextLine 正常推进）；其余记录按定价表 + 可配置 cost multiplier 计费，无定价项则 costUsd 保持空。
6. **日聚合**：入库同事务按 `(date, app_type, model)` 桶累加 upsert（`recordUsage` 实时维护镜像）；费用以微美元整数精度累加后回写字符串；明细可裁剪（prune），历史趋势由 rollups 保证。
7. **实时刷新**：新增记录数 > 0 才发 `usage-updated`（200ms 防抖合并），渲染端 `useUsageEvents` 订阅后失效 6 个用量 queryKey 触发重拉。
8. **零成本回填**：定价变更或同步后，`pricing.backfillZeroCost` 重算 `cost=0/null` 明细并增量修正 rollup 费用（触发于应用启动、每次 models.dev 全量同步）。

## 关联页面

- [插件体系](plugin-architecture.md) — 数据更新如何经事件总线推送。
- [总体架构](architecture.md) — 各环节归属的模块。
- [数据模型](data-model.md) — 明细/聚合表结构。
- [同步与去重](sync-mechanism.md) — 机制 1/2/3/7 的细节。
- [返回目录](../index.md)
