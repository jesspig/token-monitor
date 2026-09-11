---
type: architecture
title: 总体架构
description: Electron 主进程插件宿主、31 插件工厂装配、schema v14、只读查询 worker 池、可替换快照与六页渲染层。
tags: [architecture, electron, plugin-host, worker-pool, sqlite, snapshot]
resource: src/main/
timestamp: 2026-09-11T12:03:38+08:00
---

# 总体架构

> [!note] 当前状态
> 当前为 Electron + TypeScript 本地桌面应用，主进程承担采集、计费、存储、调度和查询协调，渲染进程只经 preload 白名单访问。宿主装配 31 个插件，数据库 schema 为 v14。typecheck、54 文件 / 1166 用例和生产构建已通过。

## 分层结构

```text
Electron 主进程
├─ core/
│  ├─ registry.ts       插件注册、启停与状态
│  ├─ context.ts        storage/pricing/events/scheduler/watcher 服务容器
│  ├─ lifecycle.ts      可逆装载与卸载
│  └─ event-bus.ts      usage-updated 事件
├─ plugins/
│  ├─ 31 个 <id>.ts 插件
│  └─ _lib/             Tencent Buddy、Qoder、OpenCode-like、Cline/Roo、Kilo 等共享内核
├─ services/
│  ├─ db.ts             schema v14 与迁移
│  ├─ storage.ts        明细、requestId、可替换快照、日/小时聚合
│  ├─ pricing.ts        计价、回填与缓存口径重算
│  ├─ scheduler.ts      定时兜底
│  ├─ watcher.ts        chokidar 定向监听
│  ├─ usageQuery.ts     查询实现
│  ├─ modelsdev.ts      models.dev 定价同步
│  └─ budget.ts / cli-version.ts
├─ worker/queryClient.ts       两 worker 查询 RPC 客户端
├─ workers/query-worker.ts     只读 SQLite 查询 worker
├─ collector.ts                插件级并发采集编排
├─ host.ts                     宿主装配、设置、调度和生命周期
├─ tray.ts                     系统托盘
└─ index.ts                    Electron 应用入口

preload/
└─ contextBridge RendererApi 白名单

renderer/
└─ React + Tailwind + TanStack Query + ECharts 六页界面
```

## 插件装配

`host.ts` 不再维护可直接导出的静态 `BUILTIN_PLUGINS` 常量；当前通过：

```text
createBuiltinPlugins(getTraeTrajectoryRoots)
```

工厂返回 31 个 `MonitorPlugin`。其中 Trae Agent 由 `createTraeAgentPlugin(getTraeTrajectoryRoots)` 构造，设置读取函数通过参数显式注入；其他插件使用模块导出的插件对象。宿主再为每个插件包装可逆 `onMount` watcher 行为。

新增普通插件仍需：

1. 新增 `plugins/<id>.ts` 实现 `MonitorPlugin`。
2. 在 `createBuiltinPlugins` 返回数组登记。
3. 同步 AppType、展示元数据和必要的 CLI 版本探测。
4. 如果需要运行时配置，优先通过工厂参数显式注入，不直接读取宿主实现。

Trae 是当前工厂装配特例：设置变化后重建多根 watcher，插件禁用或卸载时清理 watcher。

## 进程和线程边界

- 主进程承担全部文件、SQLite、计价和设置逻辑。
- preload 只暴露 `RendererApi`：21 成员，即 20 个 invoke 通道与 `onUsageUpdated` 事件订阅。
- 渲染进程不直接访问 Node、文件系统或 SQLite。
- `better-sqlite3` 写连接只在主进程使用。
- 文件数据库模式下，12 个 `UsageQueryService` 方法经两 worker 池的只读连接执行；重聚合进入 pool[0]，轻查询进入 pool[1]，相同 method+args 进行 in-flight 去重。
- `:memory:` 或 worker 启动失败时回退主进程直查。

## 启动与生命周期

`bootstrapHost` 完成数据库、迁移、存储、定价 seed、设置和 context 组装后即可创建窗口；`startServices()` 再装载插件、注册 watcher 和调度。所有 IPC handler 通过 `host.ready` 门控。

卸载或退出时必须清理：

- 插件 watcher 和插件自身缓存/worker。
- scheduler、定价同步计时器和启动错峰计时器。
- 查询 worker 池。
- tray 和数据库连接。

窗口关闭在 `closeToTray=true` 时只隐藏，采集继续运行；真正退出才释放宿主资源。

## 存储架构

schema v14 保持六表结构，新增能力位于 `usage_records`：

- `request_id`：稳定上游请求身份。
- `is_replaceable_snapshot`：受控成功快照更新标记。
- 同源 requestId 唯一部分索引。

存储写事务支持两种模式：

- 不可变事件：文件行主键 + dedup ledger，first-write-wins。
- 可替换成功快照：同源同 requestId 且新旧均可替换、均 success 时更新原明细，并从当前明细重建受影响日/小时桶。

当前只有 Claude、Kiro current、Droid 按条件启用可替换快照。错误、无稳定 ID 和其他插件仍是不可变事件。

## 采集架构

`collector.syncAll()` 以 `SYNC_CONCURRENCY=4` 做插件级有界并发；单插件内文件串行，保证游标和事务顺序。每文件流程：

```text
mtime 短路 → parseFile → 全零过滤 → 批量计价 → recordUsage → setCursor → 事件
```

插件可以把 `fromLine` 解释为普通行号、rowid、编码数据库水位、数组位置或快照基线；DSH 另使用 `nextByteOffset`。插件文档必须逐源写明，不能统一称为“行游标”。

## 渲染层

六页：Dashboard、请求日志、统计、定价、监控源、设置。`App.tsx` 对已访问页常驻渲染并用 `display:none` 切换；时间范围来自 FilterContext，查询使用 `keepPreviousData + staleTime 2min`。ECharts 经 `useECharts` 与 `chart-theme` 统一管理，数据状态由 `QueryState` 展示，操作反馈使用 Toast。

设置页新增 Trae trajectory 多根目录：renderer 只收集文本，绝对路径规范化、存在性和目录校验由主进程完成；保存后宿主动态刷新 Trae watcher。

## 关键约束

- 外部 CLI 日志和数据库只读。
- 插件只通过 context 或显式参数获取依赖。
- schema 不兼容必须区别于空数据。
- 未验证 Token 字段不估算。
- 定价唯一写入口为宿主 models.dev 同步，seed 仅离线兜底。
- 文档是行为事实来源，代码修改需同步概念页与 changelog。

## 关联页面

- [插件体系](plugin-architecture.md)
- [监控插件](monitor-plugins.md)
- [数据流](data-flow.md)
- [数据模型](data-model.md)
- [UI 页面](ui-pages.md)
- [返回目录](../index.md)
