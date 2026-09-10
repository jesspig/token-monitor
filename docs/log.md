# 更新日志（按天）

> 仅保留最近 7 天。详细按小时记录见 [changelog/](changelog/)。

## 2026-09-10

- **图表层 ECharts 迁移与 UI/UX 系统化**：图表库由 Recharts 整体迁移至 ECharts 6.1（按需注册，`useECharts` + `chart-theme` 统一承载，分包改 `echarts|zrender → 'echarts'` chunk，recharts 卸载）；新增 QueryState 四态边界 / Toast / Toggle / useDismissable 并六页接入，空态与文案改用户视角，时间范围经 FilterContext 全局化（默认 7d、统计页获得自定义区间），DimensionTable 无障碍与分页展开、tailwind 语义设计 token 与 `formatCompact` 落地。typecheck 两段通过 / 463 用例通过，`pnpm build` 通过。详见 [changelog/2026-09-10-00](changelog/2026-09-10-00.md)。
- **图表与布局视觉修正 + 滚动容器重构**：统计页「使用量 Top 10」与「费用占比」取消两列并排、恢复单列全宽纵向堆叠；仪表盘两图全系列 `smooth: true` 平滑曲线、请求趋势单系列 emerald 面积渐变；图例修正——`LEGEND_STYLE` 固定 `top: 0`、`GRID_STYLE.top` 8→36 留位（修正 ECharts 6 新默认主题图例落绘图区内底部与柱/X 轴重叠），统计页堆叠柱图例 `type: 'scroll'` 横向滚动、donut 图例保持底部；`App.tsx` main 改 `overflow-y-auto` 全宽滚动 + 内层 `mx-auto max-w-6xl` 版心居中，`index.html` html/body/#root 锁 100% 高度禁滚——main 成为唯一滚动容器，双滚动条根治；删冗余 `w-full`；定价页 `PRICING_PAGE_SIZE` 50 → 15。typecheck / 463 用例 / build 通过。详见 [changelog/2026-09-10-01](changelog/2026-09-10-01.md)。
- **知识库全量代码-文档配对审计（/repo-wiki）**：以当前工作区代码（typecheck 两段 / vitest 463 用例 / build 通过）为基准对 `docs/` 全部概念页逐陈述核对并重算全部数值（页面 6/组件 13/hooks 12/插件 8/schema v11/invoke 通道 20/RendererApi 成员 21）；七个文档页差异修复——ui-pages 8 处（RendererApi 21 成员契约、token 本地化描述纠正、轮询 6 处）、architecture 4 处（`register.ts` 通道组成、workers 目录树补全）、data-flow 2 处（1500ms 防抖与轮询来源）、index/log 补 01 点档摘要、roadmap 现状推进至 09-10、pricing 分页 15/页；data-model/sync-mechanism/monitor-plugins/plugin-architecture/overview 五页零差异；同步根 `AGENTS.md` RendererApi 契约（21 成员 = 20 invoke 通道 + onUsageUpdated 事件订阅）。详见 [changelog/2026-09-10-02](changelog/2026-09-10-02.md)。
- **第二批 14 监控数据源落地（内置插件 8 → 22）**：基线预登记（AppType/CLI_VERSION_COMMANDS/APP_META 各补 14 键）+ **v12 迁移**（`idx_usage_records_cached_input` DROP 重建为 semantics=1 七源组：codex/gemini/grok + workbuddy/codebuddy/qwen/reasonix，`recalcCachedInputCosts` 候选 SQL 同步）；11 个插件任务产出 14 源（cline 系三源共享内核、腾讯系双源共享 `_lib/tencent-buddy.ts`、qoder 系双源共享 `_lib/qoder-shared.ts`，`BUILTIN_PLUGINS` 登记 22 项，各配单测）；两项关键调研修正——qwen/reasonix semantics=1 经上游源码确证、kiro usage 唯一落点为伴生 sidecar 且 explicit 计数当前恒 0（不做估算回退，待真实数据回填验证）；知识库同步——monitor-plugins 校准 22 插件已实现、data-model v12、pricing 七源重算范围、ui-pages 监控源 22 插件。vitest 全量 **840 用例**通过（Electron 内置 Node），typecheck 两段 / `pnpm build` 通过。详见 [changelog/2026-09-10-03](changelog/2026-09-10-03.md)。
- **知识库二次一致性校准**：以工作区代码复核第二批 14 源 / v12 落地后的概念页与 `AGENTS.md`，修正 semantics 计数（1=八源 / 2=十一源 / 0=三源）、requestId 覆盖（22 插件中 20 个产出，kimi/reasonix 例外）、存量重算候选七源（不含 zcode）、SQLite 短超时五源、`architecture.md` schema 版本与「主进程无改动」误述、`data-flow.md` 类型标识；补齐 09-09 日摘要并统一「第二批」术语。详见 [changelog/2026-09-10-20](changelog/2026-09-10-20.md)。

## 2026-09-09

- **死代码清理：移除四个零引用退役组件**：删除趋势页退役后残留的 `TrendsPage.tsx` 与 `TrendChart.tsx` / `DimensionChart.tsx` / `ShareChart.tsx` 三个零引用图表组件（全仓 grep 查证零引用），同步修订 `concepts/ui-pages.md`。详见 [changelog/2026-09-09-23](changelog/2026-09-09-23.md)。

