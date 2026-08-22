---
type: ui-design
title: UI 页面规划
description: 渲染层页面：Dashboard（含预算横幅）、趋势、日志（模型/项目筛选）、统计、定价（models.dev 目录）、监控源、设置。
tags: [ui, react, dashboard, recharts, budget]
resource: src/renderer/src/
timestamp: 2026-08-22T06:42:00+08:00
---

# UI 页面规划

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）：渲染层 7 个页面落地于 `src/renderer/src/`。数据层经 `api.ts` 封装 `window.api`（对齐 `shared/ipc.ts` RendererApi 契约，现 21 方法），主进程 IPC 未就绪时自动回退 `mock.ts` Mock 数据。**2026-08-22 增强**：实时刷新订阅、今日小时桶后端化、日志页模型/项目筛选、定价页 models.dev 目录、设置页定价自动同步与预算字段、Dashboard 预算横幅。

## 页面清单

| 页面 | 内容 | 实现 |
|---|---|---|
| Dashboard | Hero 汇总卡 + 时间范围筛选（今日 / 7 天 / 30 天）+ 预算横幅（占比 ≥80% 黄色警告，超限红色） | ✅ `DashboardPage.tsx` |
| 趋势 | 请求趋势折线 + Token 趋势（输入/输出/缓存创建/缓存命中/成本）；今日小时桶由后端返回 | ✅ `TrendsPage.tsx` |
| 请求日志 | 分页表格 + 筛选（应用/模型多选/项目/时间/状态）+ 行详情 | ✅ `RequestLogsPage.tsx` |
| 统计 | 按应用 / 按模型的聚合表 | ✅ `StatsPage.tsx` |
| 定价配置 | 模型价格列表 + 增删改 + models.dev 在线目录浏览/搜索/勾选导入/全量同步 | ✅ `PricingPage.tsx` |
| 监控源 | 各 CLI 适配器状态（已检测/未安装/最近同步时间/错误数） | ✅ `SourcesPage.tsx` |
| 设置 | 同步间隔、数据保留策略、定价自动同步开关、日/月预算字段、数据目录等 | ✅ `SettingsPage.tsx` |

## 交互要点

- Hero 卡由筛选驱动，切换范围/应用/模型时同步更新。
- 趋势粒度：今日按小时经后端 `usage:hourly-trends`（getHourlyTrends，本地时区按小时 GROUP BY 明细，不补零），7/30 天按天；无前端分桶截断。
- 「监控源」页展示各监控插件状态（已检测/未安装/最近同步时间/错误数），支持启停插件。
- 日志页筛选选项来自后端 `usage:filter-options`（getFilterOptions，model/project distinct 各限 500）。
- 预算设置存于 AppSettings 的 `dailyBudgetUsd` / `monthlyBudgetUsd`（null = 未启用）；Dashboard 经 `budget:status` 获取今日/本月费用与占比渲染横幅。

## 实时刷新

- `hooks/useUsageEvents.ts` 订阅 `usage-updated` 事件，失效 5 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app`），TanStack Query 自动重新拉取。

## 组件拆分

- 共享组件（`components/`）：`HeroCard` / `StatCard` / `RangeSelector` / `EmptyState`（Mock 模式下提示「等待真实数据」）/ `Card` / `PageHeader` / `TrendChart`。
- 数据层：`api.ts`（RendererApi 门面 + Mock 自动回退）、`hooks/`（TanStack Query 封装 + useUsageEvents 实时刷新）、`mock.ts`（确定性 Mock 数据集，汇总/趋势/日志/统计互相一致）、`lib/range.ts`（RangeKey → LogFilters）、`lib/format.ts`（数字/金额/时间格式化）。

> [!todo] 待补充
> 页面的精细化交互（日志行详情联动、插件启停确认等）待后续视觉与交互迭代继续打磨。

## 关联页面

- [总体架构](architecture.md) — 渲染进程与 IPC 通信。
- [数据模型](data-model.md) — 页面数据来源。
- [返回目录](../index.md)
