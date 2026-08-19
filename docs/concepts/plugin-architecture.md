---
type: plugin-architecture
title: 插件体系
description: 一切皆插件：监控对象以插件形式装载，宿主提供注册表、服务容器、依赖注入、生命周期与事件总线。
tags: [plugin, architecture, registry, dependency-injection, lifecycle, event]
timestamp: 2026-08-19T20:25:00+08:00
---

# 插件体系

> [!note] 当前状态
> 规划阶段。插件框架为自研设计（借鉴通用插件框架的工作机制，不依赖第三方框架、不移植任何既有项目代码），尚无实现。

## 设计原则：一切皆插件

每个**监控对象**（如某个 CLI）以独立插件的形式存在，通过插件注册表动态装载/卸载。新增监控对象 = 新增一个插件，**零改动宿主**。

```
插件宿主（Electron 主进程）
├── core/            插件框架内核
│   ├── registry.ts     插件注册表：register / list / enable / disable / remove
│   ├── context.ts      服务容器 ctx：向插件暴露 storage / pricing / events / scheduler / watcher
│   ├── lifecycle.ts    依赖解析（deps）与装载/卸载；卸载调用 dispose 可逆清理
│   └── event-bus.ts    类型化事件（如 usage-updated，200ms 防抖）
├── plugins/         监控插件（每个监控对象一个独立目录）
│   └── claude/ codex/ opencode/ gemini/ grok/
├── services/        核心服务（注册进 ctx，供插件注入）
└── ipc/             IPC handler + 事件推送
```

## 核心机制

| 机制 | 说明 |
|---|---|
| 注册表 | 按插件 `id` 注册/发现/启停；宿主启动时扫描插件目录批量注册 |
| 服务容器 `ctx` | 插件通过 `ctx.<key>` 发现服务，而非直接 import 具体实现；解耦插件与宿主 |
| 依赖注入 | 插件用 `deps` 声明所需服务，宿主按依赖解析装载顺序，服务就绪后才装载插件 |
| 生命周期 | 装载（mount）/ 卸载（unmount）/ 禁用；任何注册（监听/事件/游标）都有对应 disposer，卸载时清理 |
| 事件总线 | 插件/服务间以类型化事件通信；数据更新经 `usage-updated`（200ms 防抖）推送到前端 |

## 新增监控对象的开发路径

1. 新建插件目录 `plugins/<id>/`（manifest.ts 声明 `id / name / version / deps`）。
2. 实现 `MonitorPlugin` 接口（见 [监控插件](monitor-plugins.md)）。
3. 经 `ctx` 访问服务读写数据、发事件。
4. 宿主注册后即生效；卸载不影响其它插件。

> [!todo] 待补充
> - 插件装载/卸载/热更新的具体时序与边界条件需在 M1 实现时确定。
> - 依赖循环、插件版本冲突等异常处理的策略尚未细化。

## 关联页面

- [监控插件](monitor-plugins.md) — `MonitorPlugin` 接口与内置插件。
- [总体架构](architecture.md) — 宿主在进程中的位置。
- [数据流](data-flow.md) — 插件在数据链路中的角色。
- [返回目录](../index.md)
