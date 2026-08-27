---
type: ui-design
title: UI 页面规划
description: 渲染层页面：Dashboard（预算横幅）、趋势（渐变面积双轴）、日志（模型/项目/自定义时间筛选）、统计、定价（只读列表+全量同步）、监控源（含 CLI 版本）、设置。
tags: [ui, react, dashboard, recharts, budget]
resource: src/renderer/src/
timestamp: 2026-08-28T02:27:00+08:00
---

# UI 页面规划

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）：渲染层 7 个页面落地于 `src/renderer/src/`。数据层经 `api.ts` 封装 `window.api`（对齐 `shared/ipc.ts` RendererApi 契约，现 17 方法），主进程 IPC 未就绪时自动回退 `mock.ts` Mock 数据（仅 dev 动态加载，生产构建整体剔除）。**2026-08-22 增强**：实时刷新订阅 + 可配置轮询、今日小时桶后端化、日志页模型/项目筛选、Dashboard 预算横幅、定价页只读化（列表 + 一键全量同步，目录浏览/手动改价已下线）、监控源页 CLI 版本展示、固定侧边导航布局与全局深色滚动条；同日第四轮迭代——时间范围扩为五档（today/24h/7d/14d/30d）、统计页「按模型」视图移除应用列、轮询与价格同步间隔改为设置可配。**2026-08-23 增强**：时间范围新增「自定义」档（起止日期面板）、趋势页 Token 主图四序列渐变面积、token 数量级中文本地化（亿/万）。**2026-08-26 秒开优化**：内联骨架屏、七页 React.lazy 懒加载 + manualChunks 分包、事件失效冷却节流、QueryClient gcTime 30 分钟、定价表分页、模型筛选候选渲染上限（详见「加载性能」）。**同日刷新收窄与交互修复**：全局默认轮询移除、仅用量类查询显式轮询（「统计自动刷新间隔」语义随之收窄）、usage-updated 失效改 1.5s 防抖、日志搜索 300ms 防抖 + keepPreviousData、设置页仅首载回填。

## 页面清单

| 页面 | 内容 | 实现 |
|---|---|---|
| Dashboard | Hero 汇总卡 + 时间范围筛选（五档 + 自定义）+ 预算横幅（占比 ≥80% 黄色警告，超限红色） | ✅ `DashboardPage.tsx` |
| 趋势 | 请求趋势折线 + Token 趋势（输入/输出/缓存创建/缓存命中四序列**渐变面积**堆叠 + 成本虚线右轴）；today 与 24h 范围由后端返回小时桶，其余范围按天 | ✅ `TrendsPage.tsx` |
| 请求日志 | 分页表格 + 筛选（应用/模型多选/项目/时间/状态）+ 关键字搜索（输入 300ms 防抖，查询值与输入值分离，发布后回第 1 页）+ 行详情；自定义区间应用时重置分页；翻页/筛选切换 keepPreviousData 不闪空 | ✅ `RequestLogsPage.tsx` |
| 统计 | 按应用 / 按模型两个聚合表 tab（维度各自独立，「按模型」视图不含应用列，表格最小宽度 800px） | ✅ `StatsPage.tsx` |
| 定价配置 | 模型价格**只读列表**（含来源列 seed/sync/user，50/页分页 `PRICING_PAGE_SIZE`）+「立即全量同步」按钮；增删改与在线目录浏览已下线 | ✅ `PricingPage.tsx` |
| 监控源 | 各 CLI 适配器状态（已检测/未安装/**CLI 版本**/最近同步时间/错误数） | ✅ `SourcesPage.tsx` |
| 设置 | 同步间隔、数据保留策略、日/月预算字段、统计自动刷新间隔（秒）/ 价格同步间隔（分钟）、数据目录等（定价自动同步无启停开关，仅暴露同步间隔）；统计自动刷新间隔仅控制用量类图表轮询（2026-08-26 收窄）；表单回填仅首载一次，不被数据刷新覆盖编辑中输入 | ✅ `SettingsPage.tsx` |
| 设置·关闭到托盘 | `closeToTray`（默认 true）：窗口关闭时隐藏到托盘而非退出，由 `tray.ts` 与 `index.ts` 协同实现，详见 [总体架构](architecture.md) | ✅ `SettingsPage.tsx` / `src/main/tray.ts` |

## 交互要点

- Hero 卡由筛选驱动，切换范围/应用/模型时同步更新。
- 时间范围 = 五档（`lib/range.ts` RANGE_OPTIONS：today = 本地今天 0 点到现在；24h = 最近 24 小时滚动窗口；7d / 14d / 30d 按天回溯）+ **custom 自定义档**。RangeKey → LogFilters 为纯时间戳过滤，后端无档位概念。
- 自定义档交互（`RangeSelector` 可选 props `customRange`/`onCustomRangeChange`，未传时组件为纯五档按钮组）：五档尾部「自定义」按钮开合内联面板——两个原生 `<input type="date">`（min/max 联动先后）、两值齐备且合法且 start≤end 才可「应用」（触发 `onChange('custom')`），「清除」回落 7d；点击遮罩关闭。`lib/range.ts` 的 `customRangeToMs` 把 YYYY-MM-DD 区间转为本地 [00:00, 23:59:59.999]，非法输入返回 null 由调用方兜底。Dashboard / 趋势 / 日志三页接线；统计页仍为纯五档。
- 趋势/仪表盘粒度分支：today 与 24h 走小时聚合，经后端 `usage:hourly-trends`（getHourlyTrends，本地时区按 (day_key, hour) 双维 GROUP BY 明细，不补零）；其余范围（含 custom）走天聚合。无前端分桶截断。小时桶含日期维度（dayKey），跨天窗口不合并同钟点——24h 滚动窗口横跨两个自然日时「昨天 9 点」与「今天 9 点」是独立桶；出现 ≥2 个不同 dayKey 时横轴标签为 'MM-DD HH:00'，单一日期维持 'HH:00'。
- 「监控源」页展示各监控插件状态（已检测/未安装/CLI 版本/最近同步时间/错误数），支持启停插件；CLI 版本显示 `cliVersion ?? '未知'`（探测机制见 [监控插件](monitor-plugins.md)）。
- 日志页筛选选项来自后端 `usage:filter-options`（getFilterOptions，model/project distinct 各限 500）。
- 预算设置存于 AppSettings 的 `dailyBudgetUsd` / `monthlyBudgetUsd`（null = 未启用）；Dashboard 经 `budget:status` 获取今日/本月费用与占比渲染横幅。
- token 数量级格式化（`lib/format.ts` formatNumber/formatTokens）随语言本地化：zh 语景 ≥1e8 显示「亿」（2 位小数去尾零）、≥1e4 显示「万」（1 位），其余千分位；其他 locale 维持 K/M/B 缩写；显式 locale 参数优先于 navigator.language。

## 实时刷新

- `hooks/useUsageEvents.ts` 订阅 `usage-updated` 事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），TanStack Query 自动重新拉取；失效合并为 **1500ms 防抖**（`INVALIDATE_DEBOUNCE_MS`，2026-08-26 由 1000ms 冷却节流 `INVALIDATE_COOLDOWN_MS` 改防抖）：事件流安静 1.5s 后合并失效一次，CLI 活跃期高频推送不再每秒一轮全量重取；卸载时清理 timer。
- 全局默认 `refetchInterval` 已移除（2026-08-26）：仅用量类查询显式轮询——useUsageSummary / useDailyTrends / useStats×2 / useRequestLogs + Dashboard 内联 hourly 与 budget-status + Trends 内联 hourly 共 8 处，统一 `refetchInterval: getStatsRefreshInterval`（经 `lib/settings-cache.ts` 动态读取设置项 `statsRefreshIntervalMs`，默认 30000ms，窗口失焦自动暂停）；设置项「统计自动刷新间隔」语义随之收窄为**仅控制用量类图表轮询**。settings/plugins/pricing/filter-options 等静态查询不再轮询，依赖挂载刷新与操作后 invalidate（SourcesPage/PricingPage/SettingsPage 已有手动失效）。查询缓存 `gcTime` 为 **30 分钟**（`QUERY_CACHE_GC_TIME`，2026-08-26），懒加载页切走后数据不立即丢弃，切回即时渲染。

## 加载性能（2026-08-26）

- **骨架屏**：`index.html` 内联纯 CSS 骨架（侧边栏 + 页头 + 五卡网格 + 图表占位，配色 #0a0a0a/#262626 对齐主题）直接置于 `#root` 内，React render 后自动替换；BrowserWindow `backgroundColor: '#0a0a0a'` 消除白闪。
- **路由级代码分割**：`App.tsx` 七页全部 `React.lazy` + `Suspense`（PAGES 类型 `LazyExoticComponent<ComponentType>`），切页按需加载 chunk。
- **分包**：`electron.vite.config.ts` renderer 段 manualChunks——charts（recharts/d3-/victory-vendor）/ query（@tanstack）/ vendor（react|react-dom|scheduler）；首屏 entry JS 由 1574.8KB 降至 20.66KB，recharts（862.36KB）随懒加载页按需请求。
- **Mock 生产剔除**：`mock.ts` 仅 dev 经 `import.meta.env.DEV` 守卫动态 import，生产构建整体剔除（bundle 无 mock 符号）；`api.ts` 的 isMock 判定改为 bridge 存在性探测（校验 `window.api` 方法签名），api 门面的 mock 路径惰性加载。
- **重渲染与大数据量治理**：`TrendChart` 包 React.memo；日志页模型筛选候选渲染上限 200 条（`MODEL_FILTER_RENDER_LIMIT`）+ 输入过滤（过滤作用于全量候选、仅渲染切片截断）。
- **刷新收窄与交互修复（2026-08-26 第二轮）**：RequestLogsPage 关键字搜索经新 hook `useDebouncedValue` 做 300ms 防抖（查询值与输入值分离，发布后回第 1 页）；`useRequestLogs` 加 `placeholderData: keepPreviousData`，翻页/筛选切换保留旧数据、表格不闪空；SettingsPage 表单回填仅首载一次（hydratedRef 守卫），不再被数据刷新覆盖编辑中输入。

## 布局与样式

- `App.tsx` 外层 `h-screen overflow-hidden`，左侧导航栏**固定不随页面滚动**；内容列为 `min-h-0 flex-col`，`<main>` 是唯一 `overflow-y-auto` 滚动容器（移动端顶部标签栏随内容列布局）。
- `index.css` 追加全局深色滚动条样式（WebKit `::-webkit-scrollbar` 系列 + Firefox `scrollbar-color` 兜底）。

## 组件拆分

- 共享组件（`components/`）：`HeroCard` / `StatCard` / `RangeSelector`（含可选自定义日期面板）/ `EmptyState`（Mock 模式下提示「等待真实数据」）/ `Card` / `PageHeader` / `TrendChart`。
- 数据层：`api.ts`（RendererApi 门面 + Mock 自动回退，mock 路径惰性加载、生产剔除）、`hooks/`（TanStack Query 封装 + useUsageEvents 实时刷新）、`mock.ts`（确定性 Mock 数据集，汇总/趋势/日志/统计互相一致，仅 dev 加载）、`lib/range.ts`（RangeKey 六档 → LogFilters + CustomRange 解析）、`lib/settings-cache.ts`（设置内存缓存，供 refetchInterval 等非组件路径动态读取）、`lib/format.ts`（数字/金额/时间格式化 + 数量级本地化）。

> [!todo] 待补充
> 页面的精细化交互（日志行详情联动、插件启停确认等）待后续视觉与交互迭代继续打磨。

## 关联页面

- [总体架构](architecture.md) — 渲染进程与 IPC 通信。
- [数据模型](data-model.md) — 页面数据来源。
- [返回目录](../index.md)
