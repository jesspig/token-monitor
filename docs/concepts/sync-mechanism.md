---
type: sync-design
title: 同步与去重
description: 增量游标 + chokidar 监听 + 定时兜底扫描；fork/rewrite 场景用去重账本拦截。
tags: [sync, dedup, cursor, chokidar, watcher]
timestamp: 2026-08-19T20:25:00+08:00
---

# 同步与去重

> [!note] 当前状态
> 规划阶段，机制为设计描述，尚无实现。

## 同步策略

- **首次**：全量扫描 → 游标记录行数。
- **增量**：比较 `mtime` 变化后从 `line_offset` 续读；文件被 truncate/替换时重置游标。
- **兜底**：定时全量 `listFiles + parse`（默认 **5 分钟**），弥补 chokidar 漏事件。

## 去重策略

- 以 `(file_path, line)` 为天然唯一键。
- fork/rewrite 场景用 `semantic_id`（如 `app_type+model+tokens+time` 归一化指纹）查 `dedup_ledger` 拦截重复入库。

## 实时刷新

- 每次同步有新增记录即发 `usage-updated` 事件（**200ms 防抖**），前端自动刷新。

> [!todo] 待补充
> - semantic_id 的具体指纹组成、防抖/合并窗口数值需在实现时确定。
> - 去重正确性（fork/rewrite 双算与漏算的平衡）需样本验证。

## 关联页面

- [监控插件](monitor-plugins.md) — parseFile 的游标推进。
- [数据模型](data-model.md) — `sync_cursors` / `dedup_ledger` 表。
- [数据流](data-flow.md) — 机制 1/2/3/7 的位置。
- [返回目录](../index.md)
