---
type: ui-design
title: UI 页面规划
description: 渲染层页面：Dashboard、趋势、日志、统计、定价、监控源、设置。
tags: [ui, react, dashboard, recharts]
resource: src/renderer/src/
timestamp: 2026-08-21T23:41:51+08:00
---

# UI 页面规划

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）：渲染层 7 个页面（T13 基座 + T14 趋势 + T15 日志/统计 + T16 定价/监控源/设置）落地于 `src/renderer/src/`。数据层经 `api.ts` 封装 `window.api`（对齐 `shared/ipc.ts` RendererApi 契约），主进程 IPC 未就绪时自动回退 `mock.ts` Mock 数据；后端 IPC 实现后自动切换真实数据（T17/T18 联调完成）。

## 页面清单

| 页面 | 内容 | 实现 |
|---|---|---|
| Dashboard | Hero 汇总卡 + 时间范围筛选（今日 / 7 天 / 30 天） | ✅ `DashboardPage.tsx` |
| 趋势 | 请求趋势折线 + Token 趋势（输入/输出/缓存创建/缓存命中/成本） | ✅ `TrendsPage.tsx` |
| 请求日志 | 分页表格 + 筛选（应用/模型/时间/状态）+ 行详情 | ✅ `RequestLogsPage.tsx` |
| 统计 | 按应用 / 按模型的聚合表 | ✅ `StatsPage.tsx` |
| 定价配置 | 模型价格列表 + 增删改 | ✅ `PricingPage.tsx` |
| 监控源 | 各 CLI 适配器状态（已检测/未安装/最近同步时间/错误数） | ✅ `SourcesPage.tsx` |
| 设置 | 同步间隔、数据保留策略、数据目录等 | ✅ `SettingsPage.tsx` |

## 交互要点

- Hero 卡由筛选驱动，切换范围/应用/模型时同步更新。
- 趋势粒度：今日按小时（24 点），7/30 天按天。
- 「监控源」页展示各监控插件状态（已检测/未安装/最近同步时间/错误数），支持启停插件。

## 组件拆分

- 共享组件（`components/`）：`HeroCard` / `StatCard` / `RangeSelector` / `EmptyState`（Mock 模式下提示「等待真实数据」）/ `Card` / `PageHeader` / `TrendChart`。
- 数据层：`api.ts`（RendererApi 门面 + Mock 自动回退）、`hooks/`（TanStack Query 封装）、`mock.ts`（确定性 Mock 数据集，汇总/趋势/日志/统计互相一致）、`lib/range.ts`（RangeKey → LogFilters）、`lib/format.ts`（数字/金额/时间格式化）。

> [!todo] 待补充
> 页面的精细化交互（趋势粒度细化、日志行详情联动、插件启停确认等）待后续视觉与交互迭代继续打磨。

## 关联页面

- [总体架构](architecture.md) — 渲染进程与 IPC 通信。
- [数据模型](data-model.md) — 页面数据来源。
- [返回目录](../index.md)
