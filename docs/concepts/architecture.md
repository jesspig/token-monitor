---
type: architecture
title: 总体架构
description: 插件宿主（Electron 主进程）承担全部数据逻辑，渲染进程经 preload contextBridge 白名单通信。
tags: [architecture, electron, main-process, renderer, ipc, plugin-host]
resource: src/main/
timestamp: 2026-08-26T00:21:00+08:00
---

# 总体架构

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）。分层结构落地于 `src/main`（core/、plugins/、services/、ipc/）+ `src/preload` + `src/renderer`，与仓库实际代码一致。2026-08-22：IPC 收窄至 17 方法（定价只读化），新增 CLI 版本探测服务，schema 升级至 v3。**2026-08-26：启动拆两阶段（bootstrapHost 快速段 + startServices 阶段二），窗口创建不再被插件装载阻塞；全部 IPC handler 经 `host.ready` 门控；首轮采集错峰延迟触发**。

## 分层结构

```
Electron 主进程（插件宿主）
├── core/           插件框架内核
│   ├── registry.ts    插件注册表（注册/发现/启停）
│   ├── context.ts     服务容器 ctx（storage/pricing/events/scheduler/watcher）
│   ├── lifecycle.ts   依赖解析与装载/卸载（可逆清理）
│   └── event-bus.ts   类型化事件（usage-updated，200ms 防抖）
├── plugins/        监控插件（每个监控对象一个模块：<id>.ts）
│   └── claude.ts codex.ts opencode.ts gemini.ts grok.ts
├── services/       核心服务（注册进 ctx，供插件注入）
│   ├── storage.ts     SQLite 读写 + 日聚合
│   ├── pricing.ts     定价与费用计算 + 零成本回填
│   ├── scheduler.ts   定时兜底扫描
│   ├── watcher.ts     chokidar 文件监听
│   ├── usageQuery.ts  聚合查询（优先读日聚合镜像，带维度筛选时回退明细；语句级预编译缓存 prepareCached）
│   ├── modelsdev.ts   models.dev 目录拉取与定价同步
│   ├── budget.ts      预算状态计算（只读 rollups 算今日/本月费用与占比）
│   ├── cli-version.ts CLI 版本探测（execFile <cli> --version，进程级缓存）
│   ├── db.ts          建库与迁移（v1 建表 → v6 字节游标列，见数据模型页）
│   └── retention.ts   明细保留清理
└── ipc/            IPC handler（17 方法）+ 事件推送
        │
        │ contextBridge (preload 白名单 API)
        ▼
Renderer (React)：Dashboard(预算横幅) / 趋势 / 日志表 / 统计 / 定价(只读列表+全量同步) / 监控源(CLI 版本) / 设置
```

宿主编排分两阶段（2026-08-26，秒开优化）：**阶段一 `bootstrapHost`**（快速同步段）——建库迁移 → seed 定价（99 条主流模型，仅作离线兜底）→ 组装 ctx → 创建 settings store 与 collector，毫秒级完成；随后即注册 IPC 并 `createWindow`（`backgroundColor: '#0a0a0a'` 消除白闪），窗口不被插件装载阻塞。**阶段二 `host.startServices()`** 异步推进——registry 注册 8 个内置插件 → 8 插件 `Promise.all` **并行 mount**（装载时把各插件会话目录注册进 watcher，500ms 防抖触发同步）→ 注册启动钩子：延迟 30s 执行一次保留清理并经 scheduler 按 `syncIntervalMs` 同间隔周期清理（设置变更联动重启）、models.dev 首次全量定价同步延迟 10s 并按 `pricingSyncIntervalMs` 周期自动同步（无启停开关，默认 5 分钟，设置变更联动重启）、零成本回填（20s）/存量重算（30s）错峰定时器；阶段完成/失败经 `Host.ready` Promise 暴露。首轮采集在「窗口 show 且宿主就绪」后延迟 1500ms 触发（生产入口 `index.ts` 常量 `STARTUP_SYNC_DELAY_MS`）；启动失败经 `dialog.showErrorBox` 弹窗兜底。采集链路编排在 `collector.ts`。

## 模块职责

| 模块 | 职责 |
|---|---|
| `core/registry.ts` | 插件注册表：register / list / get / enable / disable / remove |
| `core/context.ts` | 服务容器：向插件暴露 `ctx.storage`、`ctx.pricing`、`ctx.events` 等；未就绪访问抛错 |
| `core/lifecycle.ts` | 依赖解析（deps）、延迟装载队列与卸载可逆清理（dispose + scope disposer） |
| `core/event-bus.ts` | 类型化事件；数据更新经 `usage-updated`（200ms 防抖合并）推送 |
| `plugins/` | 监控插件：实现 `MonitorPlugin`（见 [监控插件](monitor-plugins.md)） |
| `services/` | 核心服务：存储/定价(含零成本回填、批量计费 calcCostBatch)/调度/监听/查询(语句预编译缓存)/models.dev 同步/预算/CLI 版本探测/迁移/保留清理 |
| `collector.ts` | 采集编排：探测 → 列文件 → 增量解析 → 全零过滤 → 批量计费（calcCostBatch 按位回填）→ 入库 → 推游标 → 发事件；首轮同步支持 initialSyncDelayMs 错峰；getPluginStatus 并行探测各 CLI 版本 |
| `ipc/register.ts` | IPC handler（17 方法：ping + 8 查询(含 hourly-trends/filter-options) + 2 定价(pricing:list / modelsdev-sync) + 2 插件 + 2 设置 + 1 预算 + 1 事件推送）；全部 handler 统一包装 `await host.ready` 门控，宿主未就绪时调用挂起等待 |

## 关键约束

- 主进程承担**全部**数据逻辑；渲染进程只通过 preload `contextBridge` 暴露的白名单 API 通信，**禁止直接暴露 Node 能力**。
- 数据存储 `better-sqlite3` 仅主进程使用（同步 API 内部实现 + Promise 签名对外）。
- 插件只通过 `ctx` 访问服务，**不直接 import 宿主实现**；任何注册都必须可逆清理。
- 启动期窗口与 IPC 不等待插件装载：阶段二经 `Host.ready` 暴露就绪态，IPC 层统一门控挂起，消费方（如首轮采集触发）显式 await。
- 定价内存缓存（`invalidateCache`）在任何定价写入路径后必须失效；当前唯一写入路径是 models.dev 同步，宿主 `syncModelsDevPricing` 已内置失效与回填。

## 关联页面

- [插件体系](plugin-architecture.md) — 宿主内核机制。
- [数据流](data-flow.md) — 端到端处理链路。
- [数据模型](data-model.md) — 存储结构。
- [返回目录](../index.md)
