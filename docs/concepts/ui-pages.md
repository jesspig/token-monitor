---
type: ui-design
title: UI 页面规划
description: 六页渲染层、ECharts/QueryState/Toast 基建、全局筛选与 Trae trajectory 多根设置。
tags: [ui, react, dashboard, echarts, settings, trae-agent]
resource: src/renderer/src/
timestamp: 2026-09-11T12:03:38+08:00
---

# UI 页面规划

> [!note] 当前状态
> 渲染层为 6 页，使用 React、Tailwind、TanStack Query 与 ECharts 6.1。RendererApi 共有 21 成员（20 个 invoke 通道 + `onUsageUpdated`）。2026-09-11 设置页新增 Trae Agent trajectory 多根目录配置。typecheck、54 文件 / 1166 用例和生产构建已通过。

## 页面清单

| 页面 | 当前能力 |
|---|---|
| Dashboard | 汇总卡、预算横幅、请求趋势、Token 四桶/费用趋势、全局时间范围 |
| 请求日志 | app/model/project/status/关键字筛选、分页、错误列、详情抽屉和跨页下钻 |
| 统计 | model/app/project/session/status 五维表、排序、合计、占比和排行图 |
| 定价 | 只读模型价格、搜索、分页、一键 models.dev 全量同步 |
| 监控源 | 31 个插件的发现状态、CLI 版本、启停与最近错误 |
| 设置 | 同步、保留、统计刷新、价格同步、数据目录、预算、关闭到托盘、Trae trajectory 多根 |

独立趋势页已退役并合并到 Dashboard。`App.tsx` 对已访问页常驻渲染，使用 `display:none` 切换，避免反复卸载查询和图表。

## Trae trajectory 多根设置

设置页提供多行文本框，每行一个 `trajectories` 目录绝对路径：

- renderer 只执行 trim、去空和按首次出现顺序去重。
- 主进程负责绝对路径、存在性和目录类型校验；校验失败直接抛错，旧设置不变。
- 主进程规范化路径；Windows 下按不区分大小写去重。
- 配置保存到 `AppSettings.traeTrajectoryRoots?: string[]`，重启后恢复。
- 设置值优先于 `TRAE_TRAJECTORY_DIR`；设置为空时保留环境变量和旧默认候选兼容。
- 插件每次探测/列举读取最新设置，宿主更新后卸载旧 watcher 并注册当前有效根。
- 不扫描用户主目录、磁盘或未授权项目目录。
- 输入错误同时显示在字段附近和 Toast；控件通过 `aria-describedby/aria-invalid` 关联错误。

## 查询、状态与刷新

- 时间范围由 FilterContext 统一管理：today/24h/7d/14d/30d/custom。
- `rangeToFilters` 按分钟对齐，稳定 queryKey。
- 用量查询使用 `keepPreviousData + staleTime 2min + gcTime 30min`。
- `QueryState` 统一首载错误、加载骨架、空态、后台刷新失败和刷新降透明。
- `usage-updated` 经 renderer 1500ms 防抖后失效用量查询。
- 全局默认轮询已移除；只有用量类查询读取 `statsRefreshIntervalMs`。
- 设置、插件、定价等静态查询依赖挂载、手动刷新和写操作后失效。

## 图表与交互基建

- `useECharts` 管理 init、`setOption`、ResizeObserver、隐藏页恢复和 dispose。
- `chart-theme` 统一色板、tooltip、坐标轴、图例、网格与暗色骨架。
- `ToastContext` 提供成功/失败反馈。
- `Toggle` 使用 `role=switch`。
- `useDismissable` 统一 Escape、焦点圈和焦点归还。
- `DimensionTable` 支持五维切换、排序、合计、键盘下钻和“显示全部”。

## 安全边界

- renderer 不访问 Node 或文件系统。
- 本地绝对路径仅作为本机设置值，不写入公共文档或遥测。
- 一个无效 Trae 根不会使插件扫描其他未配置目录。
- 路径在保存时验证；后续目录被删除时，设置保留，监控源状态明确显示不可用。

## 关联页面

- [总体架构](architecture.md)
- [数据流](data-flow.md)
- [监控插件](monitor-plugins.md)
- [返回目录](../index.md)
