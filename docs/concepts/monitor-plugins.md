---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 5 个内置监控插件（claude/codex/opencode/gemini/grok）实现清单。
tags: [plugin, monitor, cli, claude, codex, opencode, gemini, grok]
timestamp: 2026-08-19T20:25:00+08:00
---

# 监控插件

> [!note] 当前状态
> 规划阶段。接口与实现清单为设计；第一阶段 5 个内置插件均未编码。

## `MonitorPlugin` 接口（设计）

```ts
interface MonitorPlugin {
  id: string;                // 'claude' | 'codex' | ...
  name: string;              // 显示名
  version: string;
  deps?: ServiceKey[];       // 依赖服务（如 ['storage','pricing']），宿主按依赖装载
  detect(ctx): Promise<Detection>;          // CLI 是否安装、会话目录是否存在
  listFiles(ctx): Promise<FileEntry[]>;      // { path, mtime }
  parseFile(ctx, path, fromLine): Promise<ParsedResult>; // 增量解析，返回新记录+新偏移
  dispose?(ctx): void;       // 卸载时清理监听/游标
}
```

`ParsedResult` 含 `records`、`nextLine`（游标推进）、`eof`（是否到文件尾）。

## 内置插件清单（第一阶段 5 个）

| 插件 id | 探测点 | 会话目录 | 解析源 |
|---|---|---|---|
| claude | `~/.claude/projects` | 项目目录 + `subagents/`、`workflows/wf_*` | `type=="assistant"` 消息 usage |
| codex | `~/.codex/sessions` | 日期分区 + `archived_sessions/` | rollout JSONL 精确解析 |
| opencode | `~/.opencode/sessions` | sessions | JSONL |
| gemini | `~/.gemini/sessions` | sessions | JSONL |
| grok | `~/.grok/sessions` | sessions | JSONL |

> [!todo] 待补充
> 各 CLI 的 JSONL 字段细节（如 usage 结构、时间戳字段）需在实现时基于真实会话日志逐一核实。

## 容错要求

- 文件被 CLI 写入中读到半行 → 丢弃末尾不完整行，游标停在最后完整行。
- 单文件解析失败不阻塞整体同步，记录错误并跳过。
- 对未知字段宽松解析（lenient parse），日志格式随版本演进不崩溃。

## 关联页面

- [插件体系](plugin-architecture.md) — 插件如何被宿主装载。
- [总体架构](architecture.md) — plugins 模块归属。
- [同步与去重](sync-mechanism.md) — 游标如何与 parseFile 协同。
- [返回目录](../index.md)
