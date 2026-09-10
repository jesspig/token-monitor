---
type: ui-design
title: UI 页面规划
description: 渲染层页面：Dashboard（汇总+双 ECharts 趋势图）、日志（跨页下钻至仪表盘）、统计（五维维度表+占比图）、定价（只读列表+搜索+全量同步）、监控源（含 CLI 版本）、设置；图表层 ECharts 6.1，QueryState 四态边界，时间范围全局化。
tags: [ui, react, dashboard, echarts, budget, dimension-table]
resource: src/renderer/src/
timestamp: 2026-09-11T03:05:47+08:00
---

# UI 页面规划

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）：渲染层 6 个页面落地于 `src/renderer/src/`（2026-08-29 前为 7 页，趋势页已合并退役，见下）。数据层经 `api.ts` 封装 `window.api`（对齐 `shared/ipc.ts` RendererApi 契约，现 21 成员——20 个 invoke 方法（含写操作）+ `onUsageUpdated` 事件订阅），主进程 IPC 未就绪时自动回退 `mock.ts` Mock 数据（仅 dev 动态加载，生产构建整体剔除）。**2026-08-22 增强**：实时刷新订阅 + 可配置轮询、今日小时桶后端化、日志页模型/项目筛选、Dashboard 预算横幅、定价页只读化（列表 + 一键全量同步，目录浏览/手动改价已下线）、监控源页 CLI 版本展示、固定侧边导航布局与全局深色滚动条；同日第四轮迭代——时间范围扩为五档（today/24h/7d/14d/30d）、统计页「按模型」视图移除应用列、轮询与价格同步间隔改为设置可配。**2026-08-23 增强**：时间范围新增「自定义」档（起止日期面板）、趋势页 Token 主图四序列渐变面积。**2026-08-26 秒开优化**：内联骨架屏、六页 React.lazy 懒加载 + manualChunks 分包、事件失效冷却节流、QueryClient gcTime 30 分钟、定价表分页、模型筛选候选渲染上限（详见「加载性能」）。**同日刷新收窄与交互修复**：全局默认轮询移除、仅用量类查询显式轮询（「统计自动刷新间隔」语义随之收窄）、usage-updated 失效改 1.5s 防抖、日志搜索 300ms 防抖 + keepPreviousData、设置页仅首载回填。**2026-08-28 多维与可视化迭代**：Dashboard 趋势改为六序列（请求/输入/输出/缓存读/缓存写/费用右轴）；统计页重写为五维（model/app/project/session/status）通用维度表 DimensionTable（维度切换+列排序+合计行+费用占比图，数据经新增 getStatsByProject/Session/Status，detail 路径 LIMIT 200，前端不聚合）；请求日志详情抽屉新增“在仪表盘查看此模型/应用”一键过滤；统计表行点击下钻至日志并按维度回填筛选；跨页共享筛选由 FilterContext 承载、页面导航由 NavContext 承载，RequestLogsPage 消费共享筛选使下钻真正过滤。**2026-08-29 趋势合并与性能收敛**：独立趋势页退役，**Dashboard 接入原趋势双图**（卡 1 请求趋势 Line + 卡 2 Token 四桶/成本堆叠 Area，双图按 `range` 自动切 `today/24h→hourly` 其余→daily），原 `TrendChart` 简图移除；导航由 7 页缩至 6 页（`NavContext:PageKey` 移除 `trends`，`App.tsx:visitedRef` 常驻渲染+`display:none` 切换，切页不再卸载重建）；`lib/range.ts` 起止时间均按分钟对齐以稳定 `queryKey`，`useUsageSummary/useDailyTrends/useRequestLogs` 等统一 `staleTime 2min + gcTime 30min + keepPreviousData`，全量图表 `isAnimationActive={false}` 去动画抖动，统计页 `tokenStack/costStack` 改 `Map` 一次遍历**。**2026-09-10 图表层 ECharts 迁移与 UI/UX 系统化**：图表库由 Recharts 整体迁移至 **ECharts 6.1**（按需引入 `echarts/core` + Line/Bar/Pie + Grid/Tooltip/Legend/DataZoom/Title + CanvasRenderer，recharts 已卸载）；新基建 `hooks/useECharts.ts`（init / `setOption(replaceMerge:'series')` / ResizeObserver resize / dispose，容器 0 尺寸容错，适配 `display:none` 常驻页切换时自动补 init/resize）+ `components/chart-theme.ts`（`CHART_PALETTE` 10 色统一色板——收敛原 StatsPage `PALETTE` 与 ShareChart `DEFAULT_PALETTE` 两份重复定义；TOOLTIP/AXIS/LEGEND/GRID 暗色样式常量；`buildBaseOption()` 暗色骨架工厂；`registerECharts()` 幂等按需注册）。**状态与反馈系统化**：新增 `QueryState` 四态边界组件（首载错误→错误卡+重试 / isPending→骨架 cards/chart/table 三变体 / 空→EmptyState 可带 action CTA / 正常+轮询失败→amber 提示条 `role=alert`+重试；`dimWhenRefreshing` 刷新降透明）+ Toast（success/error、2800ms、上限 4 条、右下角）+ `useDismissable`（Escape capture 关闭 + Tab 焦点圈 + 焦点移入归还）+ `Toggle`（`role=switch`）；六页全部接入 QueryState 四态，「加载中…」EmptyState 冒充加载态的用法全部移除，「等待真实数据」开发视角文案改用户视角（EmptyState 默认「暂无数据」、App.tsx Mock 徽标「演示数据模式」）。**信息架构**：时间范围全局化——FilterContext 既有 `range/customRange` API（默认 7d）激活为唯一来源，Dashboard/统计/日志三页 local state 删除，切页保持，RangeSelector 统一置于 PageHeader action 插槽（统计页因此获得自定义区间能力），Logs 默认 30d→7d。**表格与无障碍**：DimensionTable 数值列 text-right+tabular-nums、排序 th 改 button+`aria-sort`+sr-only 升降序文本、行下钻键盘可达（Tab+Enter/Space）、默认渲染 50 行+「显示全部」展开。**设计 token**：tailwind 语义色（surface/card/raised、line、content、success/warning/danger/info）+ 全局 `:focus-visible` emerald 描边 + `sk-shimmer` 骨架动画 + `prefers-reduced-motion` 降级；`lib/format.ts` 新增 `formatCompact`（B/M/k 缩写，非有限值 '—'）。

## 页面清单

| 页面 | 内容 | 实现 |
|---|---|---|
| Dashboard | Hero 汇总卡 + 时间范围筛选（FilterContext 全局，五档 + 自定义）+ 预算横幅；**双 ECharts 趋势图**——卡 1 请求趋势 Line（`requestCount`，Y 轴 `formatCompact` 修复旧版轴原始数字直出，全系列 `smooth: true` 平滑曲线 + 单系列 emerald 0.3→0 面积渐变填充，复用页面 areaGradient 工具），卡 2 Token 四桶堆叠面积渐变 + 成本虚线右轴（`yAxisIndex: 1`，全系列 `smooth: true` 平滑）；两卡按 `range` 自动切 `today/24h→hourly` 其余→daily；两图 legend 图例点击显隐为 ECharts 内置；tooltip `trigger:'axis'` + 系列级 valueFormatter（请求数→`formatNumber`、token→`formatTokens`、成本→`formatUsd`） | ✅ `DashboardPage.tsx`（图表经 `useECharts` + `chart-theme` 承载；原 `TrendsPage`/`TrendChart` 已退役删除） |
| 请求日志 | 分页表格 + 筛选（应用/模型多选/项目/时间/状态）+ 关键字搜索（输入 300ms 防抖，查询值与输入值分离，发布后回第 1 页）+ 行详情抽屉（“在仪表盘查看此模型/应用”按钮，经 FilterContext + NavContext 跳仪表盘并回填 appTypes/models 过滤，行详情 footer 仅 model 存在时渲染）；DetailDrawer/ModelFilter 接入 Escape 关闭+焦点圈（`useDismissable`），滚动锁（body overflow）仅 DetailDrawer 附带；空结果空态带「清除筛选」CTA（重置全部筛选回第 1 页）；默认时间范围 7d（FilterContext 全局）；数值列右对齐、模型列 `max-w-[180px]` truncate；自定义区间应用时重置分页；翻页/筛选切换 keepPreviousData 不闪空、刷新降透明 | ✅ `RequestLogsPage.tsx` + `FilterContext.tsx` / `NavContext.tsx` |
| 统计 | 五维通用维度表 + 九卡网格布局：Top10（LeaderboardGrid）与费用占比 donut 取消两列并排、各自单列全宽纵向堆叠（原两列高度差悬殊致右下大片空白），每日 Token/维度表/每日费用堆叠单列全宽，成功率/缓存命中/会话成本/每百万 4 紧凑卡两列（`xl:grid-cols-2`；断点 xl≥1280px 避开历史回归区间）。图表全部 ECharts——每日 Token/每日费用堆叠柱（stack，末序列 `borderRadius [4,4,0,0]`，图例 `top: 0` 固定顶部 + `type: 'scroll'` 横向滚动），费用占比 donut（`radius 45%/70%` + `padAngle 2` + **中心 title 显示区间总费用** + label 仅 >8% 显示，图例保持底部，tooltip `trigger:'item'` + 自定 formatter）；donut 与每日 Token/每日费用堆叠柱 tooltip `trigger:'axis'` + 自定 formatter；三图数据均固定取近 30 天（`getDailyModelBreakdown` fixed30d，无维度过滤时走日预聚合快路径），不随筛选区间变化，Y 轴 `formatCompact`/`formatUsd`；`tokenStack/costStack` Map 一次遍历聚合算法不变 | ✅ `StatsPage.tsx` + `DimensionTable.tsx` + `LeaderboardGrid.tsx` + `RetentionRanking.tsx` + `useDimensionStats.ts` |
| 定价配置 | 模型价格**只读列表**（含来源列 seed/sync/user，15/页分页 `PRICING_PAGE_SIZE`）+ 客户端模型搜索框（过滤后分页、过滤变化回首页）+「立即全量同步」按钮（同步结果改 toast 反馈，移除内联文字行）；增删改与在线目录浏览已下线 | ✅ `PricingPage.tsx` |
| 监控源 | 各 CLI 适配器状态（**31 个内置插件**，2026-09-10 由 8 扩至 22、2026-09-11 扩至 31，列表经 `usePlugins` 动态渲染、新增源无需页面改动；已检测/未安装/**CLI 版本**/最近同步时间/错误数）；启停按钮 pending/disabled + 操作结果 toast；空态引导接入 | ✅ `SourcesPage.tsx` |
| 设置 | 同步间隔、数据保留策略、日/月预算字段、统计自动刷新间隔（秒）/ 价格同步间隔（分钟）、数据目录等（定价自动同步无启停开关，仅暴露同步间隔）；统计自动刷新间隔仅控制用量类图表轮询（2026-08-26 收窄）；表单回填仅首载一次，不被数据刷新覆盖编辑中输入；保存经 try/catch + toast 成功/失败反馈 + 保存按钮 pending；托盘开关 checkbox→`Toggle`（role=switch） | ✅ `SettingsPage.tsx` |
| 设置·关闭到托盘 | `closeToTray`（默认 true）：窗口关闭时隐藏到托盘而非退出，由 `tray.ts` 与 `index.ts` 协同实现，详见 [总体架构](architecture.md) | ✅ `SettingsPage.tsx` / `src/main/tray.ts` |

## 交互要点

- Hero 卡由筛选驱动，切换范围/应用/模型时同步更新。
- **时间范围全局化（2026-09-10）**：`FilterContext` 的 `range/customRange`（默认 **7d**）是时间范围唯一来源，Dashboard/统计/日志三页 local state 已删除，**切页保持**；RangeSelector 统一置于各页 PageHeader 的 action 插槽。RangeKey = 五档（`lib/range.ts` RANGE_OPTIONS：today = 本地今天 0 点到现在；24h = 最近 24 小时滚动窗口；7d / 14d / 30d 按天回溯）+ **custom 自定义档**。RangeKey → LogFilters 为纯时间戳过滤，后端无档位概念。三页均支持自定义区间（统计页自本轮起获得该能力，修正旧版「统计页仅纯五档」）。
- 自定义档交互（`RangeSelector` 可选 props `customRange`/`onCustomRangeChange`，未传时组件为纯五档按钮组）：五档尾部「自定义」按钮开合内联面板——两个原生 `<input type="date">`（min/max 联动先后）、两值齐备且合法且 start≤end 才可「应用」（触发 `onChange('custom')`），「清除」回落 7d；点击遮罩关闭。`lib/range.ts` 的 `customRangeToMs` 把 YYYY-MM-DD 区间转为本地 [00:00, 23:59:59.999]，非法输入返回 null 由调用方兜底。
- 趋势/仪表盘粒度分支：today 与 24h 走小时聚合，经后端 `usage:hourly-trends`（getHourlyTrends，本地时区按 (day_key, hour) 双维 GROUP BY 明细，不补零）；其余范围（含 custom）走天聚合。无前端分桶截断。小时桶含日期维度（dayKey），跨天窗口不合并同钟点——24h 滚动窗口横跨两个自然日时「昨天 9 点」与「今天 9 点」是独立桶；出现 ≥2 个不同 dayKey 时横轴标签为 'MM-DD HH:00'，单一日期维持 'HH:00'。
- 「监控源」页展示各监控插件状态（31 个内置插件，列表动态渲染；已检测/未安装/CLI 版本/最近同步时间/错误数），支持启停插件（按钮 pending/disabled + toast 结果反馈）；CLI 版本显示 `cliVersion ?? '未知'`（探测机制见 [监控插件](monitor-plugins.md)）。
- **QueryState 四态边界（2026-09-10）**：六页数据区统一经 `QueryState` 组件兜底——首载错误→整页错误卡+重试；isPending→骨架（cards/chart/table 三变体，`sk-shimmer` 动画，`prefers-reduced-motion` 降级）；空→`EmptyState`（默认文案「暂无数据」，可传 action CTA，如日志页「清除筛选」）；正常但轮询失败→amber 提示条（`role=alert`）+重试。keepPreviousData 后台刷新经 `dimWhenRefreshing` 降透明提示过渡。
- **Toast 全局反馈（2026-09-10）**：`ToastContext` + `Toast` 组件（success/error 两型、2800ms 自动消失、上限 4 条、右下角 z-50）；设置保存、监控源启停、定价同步等写操作结果均走 toast，不再使用内联文字。
- 日志页筛选选项来自后端 `usage:filter-options`（getFilterOptions，model/project distinct 各限 500）。
- 预算设置存于 AppSettings 的 `dailyBudgetUsd` / `monthlyBudgetUsd`（null = 未启用）；Dashboard 经 `budget:status` 获取今日/本月费用与占比渲染横幅。
- 数字格式化（`lib/format.ts` 的 formatNumber/formatTokens，后者为前者的别名）经 `toLocaleString` 千分位本地化：zh 语景用 zh-CN、其他 locale 用 en-US（显式 locale 参数优先于 navigator.language）；数量级缩写由 `formatCompact` 承担（B/M/k，图表 Y 轴用）。

## 实时刷新

- `hooks/useUsageEvents.ts` 订阅 `usage-updated` 事件，失效 6 个用量 queryKey（`usage-summary` / `daily-trends` / `request-logs` / `stats-by-model` / `stats-by-app` / `budget-status`），TanStack Query 自动重新拉取；失效合并为 **1500ms 防抖**（`INVALIDATE_DEBOUNCE_MS`，2026-08-26 由 1000ms 冷却节流 `INVALIDATE_COOLDOWN_MS` 改防抖）：事件流安静 1.5s 后合并失效一次，CLI 活跃期高频推送不再每秒一轮全量重取；卸载时清理 timer。
- 全局默认 `refetchInterval` 已移除（2026-08-26）：仅用量类查询显式轮询——`useUsageSummary` / `useDailyTrends` / `useDimensionStats` / `useRequestLogs` + `Dashboard` 内联 `hourly` 与 `budget-status`（Trends 已合并，原单独 hourly 轮询已归入 Dashboard）共 6 处，统一 `refetchInterval: getStatsRefreshInterval`（`hooks/useStats.ts` 的 useStatsByModel/useStatsByApp 遗留同款配置，但当前无页面引用、不产生轮询）（经 `lib/settings-cache.ts` 动态读取设置项 `statsRefreshIntervalMs`，默认 30000ms，窗口失焦自动暂停）；设置项「统计自动刷新间隔」语义随之收窄为**仅控制用量类图表轮询**。`rangeToFilters` 起止时间按分钟对齐（`Math.floor(Date.now()/60_000)*60_000`）以稳定 `queryKey`，全量查询统一 `staleTime 2min + gcTime 30min + placeholderData: keepPreviousData`，切页与筛选不再闪空。settings/plugins/pricing/filter-options 等静态查询不再轮询，依赖挂载刷新与操作后 invalidate（SourcesPage/PricingPage/SettingsPage 已有手动失效）。查询缓存 `gcTime` 为 **30 分钟**（`QUERY_CACHE_GC_TIME`，2026-08-26），懒加载页切走后数据不立即丢弃；`App.tsx` 自 2026-08-29 起对已访问页 `visitedRef` 常驻渲染+`display` 切换，切回即时渲染不再重建。**2026-09-10 起**：keepPreviousData 的过渡表现统一收敛为 QueryState 的 `dimWhenRefreshing` 刷新降透明（正确处理 isPending+placeholder 组合，仅后台刷新时降透明、不闪空）；DimensionTable 原有 `useTransition` 包裹已随交互简化移除。

## 加载性能（2026-08-26 基础 + 2026-08-29/2026-09-10 收敛）

- **骨架屏**：`index.html` 内联纯 CSS 骨架（侧边栏 + 页头 + 五卡网格 + 图表占位，配色 #0a0a0a/#262626 对齐主题）直接置于 `#root` 内，React render 后自动替换；BrowserWindow `backgroundColor: '#0a0a0a'` 消除白闪。
- **路由级代码分割与常驻**：`App.tsx` 六页全部 `React.lazy` + `Suspense`（PAGES 类型 `LazyExoticComponent<ComponentType>`），切页按需加载 chunk；**已访问页经 `visitedRef` 常驻渲染+`display:none` 切换（2026-08-29）**，切回不再卸载重建，`queryKey` 分钟对齐 + `keepPreviousData` 协同避免重取闪烁。
- **分包**：`electron.vite.config.ts` renderer 段 manualChunks——`echarts|zrender → 'echarts'` chunk（2026-09-10，原 charts/recharts 分组随迁移移除）/ query（@tanstack）/ vendor（react|react-dom|scheduler）；echarts 按需引入（echarts/core + 按用图表/组件注册）控制 chunk 体积，随懒加载页按需请求。
- **Mock 生产剔除**：`mock.ts` 仅 dev 经 `import.meta.env.DEV` 守卫动态 import，生产构建整体剔除（bundle 无 mock 符号）；`api.ts` 的 isMock 判定改为 bridge 存在性探测（校验 `window.api` 方法签名），api 门面的 mock 路径惰性加载。
- **重渲染与大数据量治理**：图表自 2026-09-10 起全部 ECharts，经 `useECharts` 承载——数据更新走 `setOption(replaceMerge:'series')` 增量合并而非组件树重渲染（原 Recharts 时代靠 `isAnimationActive={false}` 关闭动画抖动，该 props 随迁移消失），ResizeObserver 负责容器尺寸变化 resize；**统计页 `tokenStack/costStack` 由 `filter` 二次扫描改为 `Map` 一次遍历**；日志页模型筛选候选渲染上限 200 条（`MODEL_FILTER_RENDER_LIMIT`）+ 输入过滤（过滤作用于全量候选、仅渲染切片截断）。
- **刷新收窄与交互修复（2026-08-26 第二轮 + 2026-08-29 补齐）**：RequestLogsPage 关键字搜索经新 hook `useDebouncedValue` 做 300ms 防抖（查询值与输入值分离，发布后回第 1 页）；`useRequestLogs`/`useUsageSummary`/`useDailyTrends` 等统一 `placeholderData: keepPreviousData` + `staleTime 2min + gcTime 30min`，翻页/筛选/切页保留旧数据、表格不闪空；`lib/range.ts` 分钟对齐使 `queryKey` 1 分钟内稳定；SettingsPage 表单回填仅首载一次（hydratedRef 守卫），不再被数据刷新覆盖编辑中输入。

## 布局与样式

- `App.tsx` 外层 `h-screen overflow-hidden`，左侧导航栏**固定不随页面滚动**；内容列为 `min-h-0 flex-col`，`<main>` 为 `min-h-0 flex-1 overflow-y-auto` **全宽滚动**（滚动条贴窗口右缘惯例位置）+ 内层 `mx-auto max-w-6xl p-6` 版心居中限宽（移动端顶部标签栏随内容列布局）；`index.html` 内联样式中 html/body 锁 `height: 100%; overflow: hidden`、`#root { height: 100% }`——禁止窗口级滚动物理，main 为应用唯一滚动容器（无 html/body 级第二条滚动条）。
- `index.css` 追加全局深色滚动条样式（WebKit `::-webkit-scrollbar` 系列 + Firefox `scrollbar-color` 兜底）。
- **语义设计 token（2026-09-10）**：`tailwind.config.cjs` theme.extend 新增语义色——surface/card/raised（背景层级）、line/line-strong（描边）、content/content-secondary/content-muted（文字层级）、success/warning/danger/info（各 DEFAULT 400 档 + bright 500 档，映射自 neutral/emerald/amber/red/sky）；页面样式改按语义 token 引用，不再散落原始色值。
- **可访问性与动效（2026-09-10）**：`index.css` 追加全局 `:focus-visible`（emerald 描边）、`@keyframes sk-shimmer` + `.sk-shimmer`（骨架微光动画）、`prefers-reduced-motion` 降级（关停 shimmer 等动效）。
- **图表主题**：`components/chart-theme.ts` 统一暗色图表样式——`CHART_PALETTE` 10 色色板、TOOLTIP/AXIS_LABEL/AXIS_LINE/AXIS_TICK/SPLIT_LINE/LEGEND/GRID 样式常量、`buildBaseOption()` 暗色骨架工厂（浅合并、整字段覆盖）、`registerECharts()` 幂等按需注册；所有图表共享，替代原各页散落的内联样式定义。

## 组件拆分

- 共享组件（`components/`，12 组件 + `chart-theme.ts` 共 13 文件）：`HeroCard` / `StatCard` / `RangeSelector`（含可选自定义日期面板，置于 PageHeader action 插槽）/ `EmptyState`（默认文案「暂无数据」，可传 action CTA）/ `Card` / `PageHeader`（均含 action 插槽）/ **`QueryState`**（四态边界：错误卡+重试 / 骨架 cards/chart/table 三变体 / EmptyState / 轮询失败 amber 提示条 + `dimWhenRefreshing`）/ **`Toast`**（经 `context/ToastContext.tsx` 提供 useToast）/ **`Toggle`**（role=switch 开关，替代原生 checkbox）/ `DimensionTable`（通用维度表：五维切换+指标视图概览/Tokens/全部+列排序——th 为 button 且带 `aria-sort` 与 sr-only 升降序文本、▲▼ aria-hidden+数值列 text-right tabular-nums（TH/TD 拆 text/num 两套）+行下钻键盘可达（Tab+Enter/Space）+默认渲染 50 行+「显示全部 N 行」展开（排序/切维度/切视图重置）+合计，已过滤全 0；合计行算法零改动）/ `LeaderboardGrid`（使用量 Top 10 卡片网格，3 大卡 + 4 列小卡）/ `RetentionRanking`（成功率/缓存命中率双排行横向点状条）。
- 图表基建：`hooks/useECharts.ts`（ECharts 实例生命周期：init / setOption（`replaceMerge:'series'`）/ ResizeObserver resize / dispose；容器 0 尺寸容错，`display:none` 常驻页切换回来自动补 init/resize）+ `components/chart-theme.ts`（色板/样式常量/buildBaseOption/registerECharts，见「布局与样式」）。
- 键盘与焦点：`hooks/useDismissable.ts`（Escape capture 关闭 + Tab 焦点圈 + 开/关焦点移入归还；RequestLogsPage 的 DetailDrawer/ModelFilter 已接入，滚动锁仅 DetailDrawer 附带）。
- 跨页状态：`context/FilterContext.tsx`（共享筛选：**range/customRange 为时间范围全局唯一来源（默认 7d，2026-09-10 激活）** + appTypes/models/project/status，set* + reset，Provider 在 AppShell 根）/ `context/NavContext.tsx`（页面导航：PageKey **6 值**唯一来源（`trends` 已移除），NavProvider 持有 page/setPage/navigate，`useNav()` 在 AppShell 消费）。
- 数据层：`api.ts`（RendererApi 门面 + Mock 自动回退，mock 路径惰性加载、生产剔除；现 21 成员（20 个 invoke 方法 + `onUsageUpdated` 事件订阅）含 getStatsByProject/Session/Status，preload/index.ts 同步暴露）+ `preload/index.ts`（contextBridge 白名单，api 满足 RendererApi）、`hooks/`（现 12 个：`useUsageSummary`/`useDailyTrends`/`useDimensionStats`（按 DimensionKey 映射 getStatsBy*）/`useRequestLogs` 用量查询 + `useUsageEvents` 实时刷新 + `useECharts`/`useDismissable`/`useDebouncedValue` 交互基建 + `useModelPricing`/`usePlugins`/`useSettings` 静态配置查询 + `useStats`（useStatsByModel/useStatsByApp，已无页面引用），用量类查询 hooks 均已 `keepPreviousData + staleTime 2min + gcTime 30min`（useRequestLogs 的 gcTime 经全局默认 30min 生效））、`mock.ts`（确定性 Mock 数据集，汇总/趋势/日志/统计互相一致，仅 dev 加载；App 徽标文案「演示数据模式」）、`lib/range.ts`（RangeKey 六档 → LogFilters + CustomRange 解析，`rangeToFilters` 分钟对齐，`queryKey` 1 分钟内稳定）、`lib/settings-cache.ts`（设置内存缓存，供 refetchInterval 等非组件路径动态读取）、`lib/format.ts`（数字/金额/时间格式化 + `formatCompact`（B/M/k 缩写，非有限值 '—'，图表 Y 轴缩写用））。

> [!todo] 待补充
> 页面的精细化交互（日志行详情联动、插件启停确认等）待后续视觉与交互迭代继续打磨。

## 关联页面

- [总体架构](architecture.md) — 渲染进程与 IPC 通信。
- [数据模型](data-model.md) — 页面数据来源。
- [返回目录](../index.md)
