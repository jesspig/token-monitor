---
type: architecture
title: 数据流
description: 会话日志经插件增量解析、去重、费用计算后写入明细与日聚合，再供前端查询。
tags: [data-flow, pipeline, usage, sqlite, plugin]
timestamp: 2026-08-19T20:25:00+08:00
---

# 数据流

> [!note] 当前状态
> 规划阶段，数据流为设计描述，尚无实现。

## 端到端链路

```
CLI 会话文件(JSONL)
  → 插件增量解析(行游标)
  → 去重
  → 费用计算
  → usage_records 明细
  → usage_daily_rollups 日聚合（明细可裁剪）
  → 前端查询（事件 usage-updated 实时刷新）
```

其中「插件增量解析」由各监控插件执行（见 [监控插件](monitor-plugins.md)）；其余环节由宿主服务承担。

## 关键机制（核心设计）

1. **增量同步**：`sync_cursors` 记录每文件 `mtime + 行偏移`，只解析新增行。
2. **去重**：`dedup_ledger` 账本，处理 fork/rewrite 导致同一请求多次出现。
3. **Token 语义归一化**：`input_semantics`（0=未知 / 1=含缓存写 / 2=纯新输入）。
4. **模型 ID 归一化**：去前缀、去日期/版本后缀、`@→-`、转小写，再查定价。
5. **费用计算**：定价表 + 可配置 cost multiplier。
6. **日聚合**：明细可裁剪（prune），长期趋势由 `usage_daily_rollups` 保证。
7. **实时刷新**：新增记录后经事件总线发 `usage-updated`（200ms 防抖），前端 invalidate 缓存。

## 关联页面

- [插件体系](plugin-architecture.md) — 数据更新如何经事件总线推送。
- [总体架构](architecture.md) — 各环节归属的模块。
- [数据模型](data-model.md) — 明细/聚合表结构。
- [同步与去重](sync-mechanism.md) — 机制 1/2/3/7 的细节。
- [返回目录](../index.md)
