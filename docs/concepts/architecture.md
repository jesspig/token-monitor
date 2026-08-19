---
type: architecture
title: 总体架构
description: 插件宿主（Electron 主进程）承担全部数据逻辑，渲染进程经 preload contextBridge 白名单通信。
tags: [architecture, electron, main-process, renderer, ipc, plugin-host]
timestamp: 2026-08-19T20:25:00+08:00
---

# 总体架构

> [!note] 当前状态
> 规划阶段。本页描述的是项目既定的架构设计，尚无对应代码实现。

## 分层结构

```
Electron 主进程（插件宿主）
├── core/           插件框架内核
│   ├── registry.ts    插件注册表（注册/发现/启停）
│   ├── context.ts     服务容器 ctx（storage/pricing/events/scheduler/watcher）
│   ├── lifecycle.ts   依赖解析与装载/卸载（可逆清理）
│   └── event-bus.ts   类型化事件（usage-updated，200ms 防抖）
├── plugins/        监控插件（每个监控对象一个独立目录）
│   └── claude/ codex/ opencode/ gemini/ grok/
├── services/       核心服务（注册进 ctx，供插件注入）
│   ├── storage.ts     SQLite 读写
│   ├── pricing.ts     定价与费用计算
│   ├── scheduler.ts   定时兜底扫描
│   ├── watcher.ts     chokidar 文件监听
│   └── usageQuery.ts  聚合查询
└── ipc/            IPC handler + 事件推送
        │
        │ contextBridge (preload 白名单 API)
        ▼
Renderer (React)：Dashboard / 趋势 / 日志表 / 统计 / 定价 / 监控源 / 设置
```

## 模块职责

| 模块 | 职责 |
|---|---|
| `core/registry.ts` | 插件注册表：register / list / enable / disable / remove |
| `core/context.ts` | 服务容器：向插件暴露 `ctx.storage`、`ctx.pricing`、`ctx.events` 等 |
| `core/lifecycle.ts` | 依赖解析（deps）与装载/卸载；卸载调用插件 `dispose` 清理 |
| `core/event-bus.ts` | 类型化事件；数据更新经 `usage-updated`（200ms 防抖）推送 |
| `plugins/` | 监控插件：实现 `MonitorPlugin`（见 [监控插件](monitor-plugins.md)） |
| `services/` | 核心服务：存储/定价/调度/监听/查询 |
| `ipc/` | IPC handler（查询 API）+ 事件推送 |

## 关键约束

- 主进程承担**全部**数据逻辑；渲染进程只通过 preload `contextBridge` 暴露的白名单 API 通信，**禁止直接暴露 Node 能力**。
- 数据存储 `better-sqlite3` 仅主进程使用（同步 API）。
- 插件只通过 `ctx` 访问服务，**不直接 import 宿主实现**；任何注册都必须可逆清理。

## 关联页面

- [插件体系](plugin-architecture.md) — 宿主内核机制。
- [数据流](data-flow.md) — 端到端处理链路。
- [数据模型](data-model.md) — 存储结构。
- [返回目录](../index.md)
