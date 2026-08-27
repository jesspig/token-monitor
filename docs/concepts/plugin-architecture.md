---
type: plugin-architecture
title: 插件体系
description: 一切皆插件：监控对象以插件形式装载，宿主提供注册表、服务容器、依赖注入、生命周期与事件总线。
tags: [plugin, architecture, registry, dependency-injection, lifecycle, event]
resource: src/main/core/
timestamp: 2026-08-28T02:27:00+08:00
---

# 插件体系

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）。自研插件框架落地于 `src/main/core/`（registry / context / lifecycle / event-bus），8 个监控插件经其装载；现内置 8 插件，宿主阶段二以 `Promise.all` **并行装载**（2026-08-26：scopes 按 plugin.id 分 key、插件间无共享可变状态，并行安全）。

## 设计原则：一切皆插件

每个**监控对象**（如某个 CLI）以独立插件模块的形式存在，经注册表动态装载/卸载。新增监控对象 = 新增一个插件模块 + 在宿主插件清单登记一行。

```
插件宿主（Electron 主进程）
├── core/            插件框架内核
│   ├── registry.ts     插件注册表：register / list / get / enable / disable / remove
│   ├── context.ts      服务容器 ctx：向插件暴露 storage / pricing / events / scheduler / watcher
│   ├── lifecycle.ts    依赖解析（deps）与装载/卸载；卸载调用 dispose 可逆清理
│   └── event-bus.ts    类型化事件（usage-updated，200ms 防抖合并）
├── plugins/         监控插件（每个监控对象一个模块：<id>.ts）
│   └── claude.ts codex.ts opencode.ts gemini.ts grok.ts pi.ts zcode.ts dsh.ts
├── services/        核心服务（注册进 ctx，供插件注入）
└── ipc/             IPC handler + 事件推送
```

## 核心机制（已实现）

| 机制 | 实现 |
|---|---|
| 注册表 | `PluginRegistry` 按 `id` 维护元数据与启用态（register/list/get/enable/disable/isEnabled/remove）；内置 8 插件由宿主 `BUILTIN_PLUGINS` 清单批量注册 |
| 服务容器 `ctx` | `createPluginContext` 构建，插件通过 `ctx.<key>` 发现服务而非直接 import 实现解耦；未就绪服务访问即抛错 |
| 依赖注入 | 插件用 `deps` 声明所需服务（ServiceKey：storage/pricing/events/scheduler/watcher），宿主校验就绪后才装载 |
| 生命周期 | `LifecycleManager`：mount 时 deps 校验 → 调用可选 `onMount` 并登记其返回的 disposer 到该插件 scope；deps 未就绪进入延迟队列，`retryDeferred` 重试；unmount 先调 `dispose?()` 再清理 scope 内全部 disposer（单条失败不阻塞其余），并移出延迟队列；scope 按 plugin.id 分 key、插件间无共享可变状态，宿主阶段二以 `Promise.all` 并行装载 8 插件（2026-08-26） |
| 事件总线 | `EventBus` 类型化事件；`usage-updated` 在 200ms 窗口内合并派发（addedRecords 累加、updatedAt 取最后）；`on` 返回 disposer 可逆清理 |

## 新增监控对象的开发路径

1. 新建插件模块 `plugins/<id>.ts`，实现 `MonitorPlugin` 接口（见 [监控插件](monitor-plugins.md)）。
2. 在宿主插件清单（`host.ts` 的 `BUILTIN_PLUGINS`）登记该模块。
3. 经 `ctx` 访问服务读写数据、发事件。
4. 宿主启动即注册并装载；停用 = 卸载（IPC `plugins:set-enabled`），可逆且不影响其它插件。

## 关联页面

- [监控插件](monitor-plugins.md) — `MonitorPlugin` 接口与内置插件。
- [总体架构](architecture.md) — 宿主在进程中的位置。
- [数据流](data-flow.md) — 插件在数据链路中的角色。
- [返回目录](../index.md)
