---
type: architecture
title: 总体架构
description: 插件宿主（Electron 主进程）承担全部数据逻辑，渲染进程经 preload contextBridge 白名单通信；统计查询经只读 worker 池 offload，采集插件级并发；仪表盘双图与 6 页导航常驻渲染。
tags: [architecture, electron, main-process, renderer, ipc, plugin-host, worker-pool]
resource: src/main/
timestamp: 2026-09-10T20:51:43+08:00
---

# 总体架构

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）。分层结构落地于 `src/main`（core/、plugins/、services/、ipc/、worker/、workers/、tray.ts）+ `src/preload` + `src/renderer`，与仓库实际代码一致。2026-08-22：IPC 收窄至 17 方法（定价只读化），新增 CLI 版本探测服务，schema 升级至 v3。**2026-08-26：启动拆两阶段（bootstrapHost 快速段 + startServices 阶段二），窗口创建不再被插件装载阻塞；全部 IPC handler 经 `host.ready` 门控；首轮采集错峰延迟触发**。**2026-08-27：统计查询 offload 到只读 worker 线程（`worker/queryClient.ts` + `workers/query-worker.ts`，WAL 共享 DB）；新增系统托盘后台常驻（`tray.ts`，关窗隐藏不退出、单实例锁、closeToTray 设置）；schema 升级至 v10（`usage_hourly_rollups` + 三筛选索引）**。**2026-08-28：IPC 维持 20 方法（当前契约见 `shared/ipc.ts:RendererApi`，现 21 方法 = 20 个 invoke 通道 + `onUsageUpdated` 事件订阅），统计查询通用化为 queryGroupBy；渲染层跨页状态抽为 FilterContext + NavContext；worker/queryClient 池化为 2 worker（重聚合/轻查询分流，in-flight 跨池去重，统一 pending/terminate），采集层插件级有界并发（SYNC_CONCURRENCY=4）+ dsh 目录列举异步化**。**2026-08-29：仪表盘接入趋势双图（请求趋势 Line + Token 四桶/成本堆叠 Area），独立趋势页退役，导航由 7 页缩至 6 页（`NavContext:PageKey` 移除 `trends`）；`App.tsx` 切页改为 `visitedRef` 常驻渲染+`display:none` 切换，查询缓存与渲染优化见 [数据流](data-flow.md)；schema 升级至 v11（`idx_usage_records_model_created`）**。**2026-09-10：渲染层图表库由 Recharts 整体迁移至 ECharts 6.1（按需注册），统一经 `hooks/useECharts.ts` + `components/chart-theme.ts`；新增 QueryState 四态边界 / ToastContext / Toggle / useDismissable 等共享基建，时间范围经 FilterContext 全局化（默认 7d），依赖分包 `echarts|zrender → 'echarts'` chunk**。**同日第二批 14 数据源接入**：主进程新增 14 个插件源码与 `_lib/` 共享解析内核、`BUILTIN_PLUGINS` 登记 8 → 22（见 [监控插件](monitor-plugins.md)）；`shared/app.ts` 的 `AppType`、`CLI_VERSION_COMMANDS` 等类型/常量各补 14 键；db 升级 v12 重建七源缓存口径索引、`pricing.recalcCachedInputCosts` 候选同步扩源（见 [数据模型](data-model.md) 与 [定价与费用](pricing.md)）**。

## 分层结构

```
Electron 主进程（插件宿主）
├── core/           插件框架内核
│   ├── registry.ts    插件注册表（注册/发现/启停）
│   ├── context.ts     服务容器 ctx（storage/pricing/events/scheduler/watcher）
│   ├── lifecycle.ts   依赖解析与装载/卸载（可逆清理）
│   └── event-bus.ts   类型化事件（usage-updated，200ms 防抖）
├── plugins/        监控插件（每个监控对象一个模块：<id>.ts）
│   └── claude.ts codex.ts opencode.ts gemini.ts grok.ts pi.ts zcode.ts dsh.ts … copilot-chat.ts（22 个内置插件 + `_lib/` 共享解析内核）
├── services/       核心服务（注册进 ctx，供插件注入）
│   ├── storage.ts     SQLite 读写 + 日聚合 + 小时聚合物化（v10）
│   ├── pricing.ts     定价与费用计算 + 零成本回填
│   ├── scheduler.ts   定时兜底扫描
│   ├── watcher.ts     chokidar 文件监听
│   ├── usageQuery.ts  聚合查询（优先读日/小时聚合镜像，带维度筛选时回退明细；语句级预编译缓存 prepareCached）
│   ├── modelsdev.ts   models.dev 目录拉取与定价同步
│   ├── budget.ts      预算状态计算（只读 rollups 算今日/本月费用与占比）
│   ├── cli-version.ts CLI 版本探测（execFile <cli> --version，进程级缓存）
│   ├── db.ts          建库与迁移（v1 建表 → v12 缓存口径七源索引重建，其间 v8/v9 失败列与存量回溯、v10 小时物化+筛选索引、v11 联合索引；启用 WAL）+ 只读连接工厂
│   └── retention.ts   明细保留清理
├── worker/        主线程侧 worker 客户端
│   └── queryClient.ts 统计查询 RPC 客户端（2 worker 池：重聚合→pool[0]/轻查询→pool[1]；in-flight 跨池去重；统一 nextId/pending/terminate；:memory: 回退直查）
├── workers/       独立线程入口
│   ├── query-worker.ts 只读 better-sqlite3 连接 + createUsageQuery（WAL 下读已提交快照，多 worker 各自独立只读连接）
│   ├── zstd-worker.ts  dsh zstd 帧级增量解压 worker（worker_threads 入口，复用 zstd-scan）
│   └── zstd-scan.ts    zstd 帧边界扫描与解压（zstd-worker 与 dsh 插件共用）
├── tray.ts        系统托盘（后台常驻入口：createTray）
└── ipc/            IPC handler（20 个 invoke 通道）+ usage-updated 事件推送（webContents.send）
          │
          │ contextBridge (preload 白名单 API，RendererApi 21 方法 = 20 invoke + onUsageUpdated 订阅，见 shared/ipc.ts)
          ▼
 Renderer (React)：Dashboard(汇总卡+双 ECharts 趋势图：请求 Line + Token 四桶堆叠面积/成本右轴) / 日志表(跨页下钻至仪表盘) / 统计(五维 DimensionTable+ECharts 堆叠柱/donut) / 定价(只读列表+搜索+全量同步) / 监控源(CLI 版本) / 设置；图表统一经 useECharts + chart-theme，数据区四态经 QueryState，反馈经 ToastContext；跨页状态 FilterContext + NavContext（6 页，PageKey 无 trends，App 根 Provider，常驻渲染+display 切换）
```

宿主编排分两阶段（2026-08-26，秒开优化）：**阶段一 `bootstrapHost`**（快速同步段）——建库迁移 → seed 定价（99 条主流模型，仅作离线兜底）→ 组装 ctx → 创建 settings store 与 collector，毫秒级完成；随后即注册 IPC 并 `createWindow`（`backgroundColor: '#0a0a0a'` 消除白闪），窗口不被插件装载阻塞。**阶段二 `host.startServices()`** 异步推进——registry 注册 22 个内置插件（2026-09-10 由 8 扩至 22）→ 22 插件 `Promise.all` **并行 mount**（装载时把各插件会话目录注册进 watcher，500ms 防抖触发同步）→ 注册启动钩子：延迟 30s 执行一次保留清理并经 scheduler 按 `syncIntervalMs` 同间隔周期清理（设置变更联动重启）、models.dev 首次全量定价同步延迟 10s 并按 `pricingSyncIntervalMs` 周期自动同步（无启停开关，默认 5 分钟，设置变更联动重启）、零成本回填（20s）/存量重算（30s）错峰定时器；阶段完成/失败经 `Host.ready` Promise 暴露。首轮采集在「窗口 show 且宿主就绪」后延迟 1500ms 触发（生产入口 `index.ts` 常量 `STARTUP_SYNC_DELAY_MS`）；启动失败经 `dialog.showErrorBox` 弹窗兜底。采集链路编排在 `collector.ts`。

## 模块职责

| 模块 | 职责 |
|---|---|
| `core/registry.ts` | 插件注册表：register / list / get / enable / disable / remove |
| `core/context.ts` | 服务容器：向插件暴露 `ctx.storage`、`ctx.pricing`、`ctx.events` 等；未就绪访问抛错 |
| `core/lifecycle.ts` | 依赖解析（deps）、延迟装载队列与卸载可逆清理（dispose + scope disposer） |
| `core/event-bus.ts` | 类型化事件；数据更新经 `usage-updated`（200ms 防抖合并）推送 |
| `plugins/` | 监控插件：实现 `MonitorPlugin`（见 [监控插件](monitor-plugins.md)） |
| `services/` | 核心服务：存储(含日/小时聚合)/定价(含零成本回填、批量计费 calcCostBatch)/调度/监听/查询(语句预编译缓存)/models.dev 同步/预算/CLI 版本探测/迁移(WAL+筛选索引)/保留清理 |
| `worker/queryClient.ts` | 统计查询 RPC 客户端：`createQueryClient(dataDir, db)`；文件库模式把查询 offload 到 **2 worker 池**（重聚合 `getStatsByProject/Session/Status` + `getRequestLogs`/`getUsageSummary`/`getDailyModelBreakdown` → pool[0]，其余轻查询 → pool[1]，v11 起 `getDailyModelBreakdown` 纳入重池以错开轻查询），相同 `(method+args)` 跨池 in-flight 去重收敛失效风暴；各 worker 独立只读连接（WAL 多读）；`:memory:`/启动失败回退主进程直查；`terminate()` 终止池内全部 worker |
| `workers/query-worker.ts` | worker 线程入口：以 `{ readonly: true, fileMustExist: true }` 打开同一 DB 文件只读连接（WAL 下读已提交快照，不阻塞主线程写者），经 `createUsageQuery` 承载查询并按消息 RPC 回传（动态派发 req.method，无需为新增维度方法加分支） |
| `tray.ts` | 系统托盘：`createTray(iconPath, {showWindow, quitApp})` 返回 `TrayHandle{destroy()}`；右键「显示/退出」、左键恢复窗口；无法创建时回退无托盘模式不抛错 |
| `collector.ts` | 采集编排：插件级有界并发（`SYNC_CONCURRENCY=4`，`syncAll` 分批 `Promise.all`）→ 单插件内文件仍串行（保游标/去重事务）；dsh 目录列举已异步化（`safeReaddirAsync` / `toEntryAsync` 用 `fs.promises`）；其余：探测 → 列文件 → 增量解析 → 全零过滤 → 批量计费（calcCostBatch 按位回填）→ 入库（同事务维护日+小时聚合）→ 推游标 → 发事件；首轮同步支持 initialSyncDelayMs 错峰；getPluginStatus 并行探测各 CLI 版本 |
| `ipc/register.ts` | IPC handler（20 个 invoke 通道：ping + 12 查询(含 hourly-trends/filter-options、stats-by-project/session/status、daily-model-breakdown) + 2 定价 + 2 插件 + 2 设置 + 1 预算）；usage-updated 事件不经 handle，由 `host.events` 订阅后 `webContents.send` 推送（对应 RendererApi 第 21 方法 `onUsageUpdated`）；全部 handler 统一包装 `await host.ready` 门控 |
| `index.ts` | 应用入口：单实例锁、窗口关→隐藏（closeToTray）、window-all-closed 常驻不退出、second-instance 聚焦、before-quit 清理（tray.destroy + host.dispose + usageQuery.terminate） |

## 关键约束

- 主进程承担**全部**数据逻辑；渲染进程只通过 preload `contextBridge` 暴露的白名单 API 通信，**禁止直接暴露 Node 能力**。
- 数据存储 `better-sqlite3` 仅主进程使用（同步 API 内部实现 + Promise 签名对外）。
- 插件只通过 `ctx` 访问服务，**不直接 import 宿主实现**；任何注册都必须可逆清理。
- 启动期窗口与 IPC 不等待插件装载：阶段二经 `Host.ready` 暴露就绪态，IPC 层统一门控挂起，消费方（如首轮采集触发）显式 await。
- 定价内存缓存（`invalidateCache`）在任何定价写入路径后必须失效；当前唯一写入路径是 models.dev 同步，宿主 `syncModelsDevPricing` 已内置失效与回填。
- **统计查询线程边界**：文件库模式下，所有统计查询经 `worker/queryClient.ts` 转发到 `workers/query-worker.ts` 只读 worker 线程执行；worker 持独立 `better-sqlite3` **只读**连接（WAL 下读已提交快照），主线程不再因同步 `better-sqlite3` 查询被阻塞。写者（采集/`recordUsage`/迁移/回填）仍走主进程读写连接，与 worker 只读连接共享同一 DB 文件，靠 WAL 并发读写隔离；`:memory:` 模式无独立文件、回退主进程直查（无线程隔离）。worker 生命周期由 `QueryClient.terminate()` 在 `before-quit` 统一清理，宿主 `dispose` 前终止，避免线程泄漏。
- **后台常驻生命周期**：`index.ts` 以 `app.requestSingleInstanceLock()` 实现单实例（第二实例聚焦已存在窗口后退出）；窗口 `close` 事件中若未显式退出且 `AppSettings.closeToTray` 为真则 `preventDefault()` + `hide()`（关窗隐藏而非退出），`window-all-closed` 在非 darwin 且未开启常驻时才 `app.quit()`（开启常驻则进程常驻不退出）；`closeToTray` 默认 `true`（宿主设置默认值，设置页新增开关可改），为 `true` 时在 `createWindow` 后创建系统托盘（`closeToTray` 关闭时销毁托盘）；真正退出经托盘「退出」或 `before-quit` 触发 `willQuit=true` 后 `tray.destroy()` + `host.dispose()`，与既有「插件宿主全在主进程、与窗口解耦」一致——窗口关闭不卸载插件、不停止采集，后台持续同步。

## 关联页面

- [插件体系](plugin-architecture.md) — 宿主内核机制。
- [数据流](data-flow.md) — 端到端处理链路。
- [数据模型](data-model.md) — 存储结构。
- [返回目录](../index.md)
