# 更新日志（按天）

> 仅保留最近 7 天。详细按小时记录见 [changelog/](changelog/)。

## 2026-09-10

- **图表层 ECharts 迁移与 UI/UX 系统化**：图表库由 Recharts 整体迁移至 ECharts 6.1（按需注册，`useECharts` + `chart-theme` 统一承载，分包改 `echarts|zrender → 'echarts'` chunk，recharts 卸载）；新增 QueryState 四态边界 / Toast / Toggle / useDismissable 并六页接入，空态与文案改用户视角，时间范围经 FilterContext 全局化（默认 7d、统计页获得自定义区间），DimensionTable 无障碍与分页展开、tailwind 语义设计 token 与 `formatCompact` 落地。typecheck 两段通过 / 463 用例通过，`pnpm build` 通过。详见 [changelog/2026-09-10-00](changelog/2026-09-10-00.md)。
- **图表与布局视觉修正 + 滚动容器重构**：统计页「使用量 Top 10」与「费用占比」取消两列并排、恢复单列全宽纵向堆叠；仪表盘两图全系列 `smooth: true` 平滑曲线、请求趋势单系列 emerald 面积渐变；图例修正——`LEGEND_STYLE` 固定 `top: 0`、`GRID_STYLE.top` 8→36 留位（修正 ECharts 6 新默认主题图例落绘图区内底部与柱/X 轴重叠），统计页堆叠柱图例 `type: 'scroll'` 横向滚动、donut 图例保持底部；`App.tsx` main 改 `overflow-y-auto` 全宽滚动 + 内层 `mx-auto max-w-6xl` 版心居中，`index.html` html/body/#root 锁 100% 高度禁滚——main 成为唯一滚动容器，双滚动条根治；删冗余 `w-full`；定价页 `PRICING_PAGE_SIZE` 50 → 15。typecheck / 463 用例 / build 通过。详见 [changelog/2026-09-10-01](changelog/2026-09-10-01.md)。
- **知识库全量代码-文档配对审计（/repo-wiki）**：以当前工作区代码（typecheck 两段 / vitest 463 用例 / build 通过）为基准对 `docs/` 全部概念页逐陈述核对并重算全部数值（页面 6/组件 13/hooks 12/插件 8/schema v11/invoke 通道 20/RendererApi 成员 21）；七个文档页差异修复——ui-pages 8 处（RendererApi 21 成员契约、token 本地化描述纠正、轮询 6 处）、architecture 4 处（`register.ts` 通道组成、workers 目录树补全）、data-flow 2 处（1500ms 防抖与轮询来源）、index/log 补 01 点档摘要、roadmap 现状推进至 09-10、pricing 分页 15/页；data-model/sync-mechanism/monitor-plugins/plugin-architecture/overview 五页零差异；同步根 `AGENTS.md` RendererApi 契约（21 成员 = 20 invoke 通道 + onUsageUpdated 事件订阅）。详见 [changelog/2026-09-10-02](changelog/2026-09-10-02.md)。

## 2026-08-29

- **趋势合并与查询性能收敛**：仪表盘接入趋势双图（请求 Line + Token 四桶/成本堆叠 Area），独立趋势页退役（6 页导航，常驻渲染 visitedRef，`rangeToFilters` 分钟对齐，`keepPreviousData` 全量收敛，`isAnimationActive=false` 去动画），`getDailyModelBreakdown` 走日预聚合快路径，`idx_usage_records_model_created` 索引 v11 落地，统计页堆叠改 `Map` 一次遍历。详见 [changelog/2026-08-29-14](changelog/2026-08-29-14.md)。

## 2026-08-28

- **统计六项精修**：使用量 Top 10（过滤全 0）、每日 Token 消耗量堆叠修复并更名、详细表过滤全 0、费用 Top 5 单条堆叠（参考市场份额）、新增缓存命中率排行、绘画成本排行与每百万 Token 堆叠；趋势回退至可用双卡并确保 `||0` 兜底。详见 [changelog/2026-08-28-23](changelog/2026-08-28-23.md)。
- **统计与趋势二次打磨（对标 OpenCode 四图，上下排布）**：修复趋势白屏并拆分三卡、统计页四图上下排布。详见 [changelog/2026-08-28-22](changelog/2026-08-28-22.md)。
- **多维与性能迭代（feature/multidim-ui-perf）**：Dashboard/Trends 改用 DimensionChart 通用组件、统计页重写为五维维度表、日志详情一键过滤与统计下钻经 FilterContext/NavContext 跨页联动、后端新增 getStatsByProject/Session/Status（detail 路径 LIMIT 200）与 queryGroupBy 通用化、IPC 20 方法与 preload 同步、worker/queryClient 池化为 2 worker（重/轻分流）、采集层插件级有界并发（SYNC_CONCURRENCY=4）+ dsh 异步列举；期间修复 App 标签不平衡、queryClient 缺方法与 status 类型等中间编译报错，typecheck / 463 单测 / 0 失败。详见 [changelog/2026-08-28-21](changelog/2026-08-28-21.md)。
- **代码注释全量移除 + 知识库一致性对齐**：移除全部源码注释（`docs/` 成为唯一事实来源）；增量修订 10 个概念页——过时「5→8 插件」表述、SSOT 锚点由代码注释改为代码符号（`isIgnoredFailureReason` / `IGNORED_FAILURE_STATUSES` / `buildWhere` 等）、`data-flow.md` 机制编号纠错（1–10 连续）、`pricing.md` 术语统一为 8 源、`ui-pages.md` 补 `closeToTray` 开关、`roadmap.md` 补当前状态；同步 `AGENTS.md`（插件数/单测数/计费语义/新增「项目知识库」章节）与 `index.md` 目录；各页 `timestamp` 刷新至 2026-08-28。详见 [changelog/2026-08-28-02](changelog/2026-08-28-02.md)。

## 2026-08-27

- **第七轮迭代（小时物化 + worker 线程 offload + 系统托盘常驻）**：db 新增 v10 迁移建 `usage_hourly_rollups` 小时聚合物化表（主键 date,hour,app_type,model，与日聚合镜像同事务增量维护，小时查询无筛选维度读该表、带 status/project/sessionId/keyword 回退明细全扫，含一次性回填与三单列索引 idx_usage_records_status/project/session_id；createDatabase 启用 WAL）；统计查询 offload 到只读 worker 线程（`workers/query-worker.ts` 只读 better-sqlite3 连接读已提交快照 + `worker/queryClient.ts` 主线程 RPC 客户端，in-flight 去重收敛 usage-updated 失效风暴，`:memory:` 回退直查）；系统托盘后台常驻（`tray.ts` createTray，关窗隐藏不退出、单实例锁、`closeToTray` 默认 true、设置页开关、`before-quit` 清理）。typecheck / 单测 / build 见各概念页与 changelog。

## 2026-08-26

- **「每步操作未响应」根治第二轮**：外部 SQLite 只读连接 busy 短超时（opencode/zcode `EXTERNAL_DB_BUSY_TIMEOUT_MS=250`，撞锁弃轮下轮重试，替代默认 5000ms 主线程冻结）；零成本回填/存量重算分批执行（rowid 游标 500 行/批、事务外计算单事务提交、批间 setImmediate 让出）并命中 v7 部分索引（idx_usage_records_zero_cost / idx_usage_records_cached_input，稳态扫描 O(全表) → O(候选数)）；dsh 解压下沉 worker_threads 单例（10s 超时销毁重建 + 异常环境恒主线程回退，构建产物 out/main/zstd-worker.js）+ 坏帧切割尝试上限 MAX_CUT_ATTEMPTS=8；collector.getPluginStatus 5s TTL 缓存（plugins:set-enabled 后主动失效）；pi/dsh detect 存在性短路递归；grok 映射 summary.json path:mtime 签名缓存；调度 schedule 支持 initialDelayMs 错相首触（retention sweep 半周期点火、启动延迟 30s→45s 错开 30s 处的存量费用重算）；渲染端移除全局 refetchInterval、仅用量类查询 8 处显式轮询（「统计自动刷新间隔」收窄为仅控制用量图表），usage-updated 失效 1000ms 节流 → 1500ms 防抖，日志搜索 300ms 防抖 + keepPreviousData 不闪空，设置页仅首载回填。typecheck 双段通过 / 29 文件 394 用例 / build 通过。
- **第六轮迭代（秒开秒切与低端机流畅度优化）**：主进程启动拆两阶段——`bootstrapHost` 快速段（建库/迁移/seed 定价/settings/ctx）后即 createWindow（backgroundColor 消白闪 + showErrorBox 兜底），8 插件 `Promise.all` 并行装载与错峰定时器注册移入异步 `startServices()`，`Host.ready` + IPC handler 统一门控，首轮采集窗口 show 且就绪后延迟 1500ms 触发；渲染端内联骨架屏、七页 React.lazy + manualChunks 分包（首屏 entry JS 1574.8KB → 20.66KB）、mock 生产剔除、TrendChart memo、失效冷却节流 1000ms、gcTime 30 分钟、定价表分页 50/页、模型筛选渲染上限 200；主进程吞吐——usageQuery 语句预编译缓存、dsh zstd 尾部帧级增量解压（scanZstdFrames + v6 字节游标 sync_cursors.byte_offset，truncate 判定收紧 mtime=0 占位不参与）、定价索引排序数组 + 二分（O(n·L) → O(L·log n)）、批量计费 calcCostBatch。typecheck 双段通过 / 28 文件 387 用例 / build 全部通过（经 Electron 内置 Node 运行）。

## 2026-08-25

- **dsh 脏游标死锁修复收尾（数据库 v5 迁移）**：初版 dsh 两级模型来源在真实数据上全部失效（`data.message.model` 全量缺失、request/header 兜底未命中），零记录产出但游标推满；commit 3203648 三级来源修复又被 a4bfa4c 的 mtime 短路挡住、历史文件永不重析——v5 迁移执行 `DELETE FROM sync_cursors WHERE file_path LIKE '%\.dsh\sessions%'` 清除脏游标触发全量重析自愈，重放安全由主键幂等 + dedup_ledger 收敛保证。实测两轮启动 120/120 文件游标回写、6084 条 dsh 记录入库（与上游 assistant/message 总数精确吻合）、dedup_ledger 同步 6084 条、deepseek-v4-flash 定价全命中带费用；claude/codex/opencode/zcode 数据完好。typecheck / 27 文件 363 用例全部通过（经 Electron 内置 Node 运行）。

## 2026-08-24

- **主进程防阻塞性能优化**：实测「每时每刻未响应」定位五个阻塞源并全部修复——采集器 mtime 短路（`getCursorMeta` 比对游标与文件 mtime，零变更文件不再重复解析，dsh zstd 整文件解压开销消除）、watcher 定向同步（新增 `syncPlugin(id)`，变更只触发对应插件而非全量扫描）、启动错峰（定价同步 10s / 零成本回填 20s / 存量重算 30s 延迟触发）、定价写入批量化（seed 与 models.dev 同步收敛单事务批量 upsert，数千次 fsync → 1 次）、渲染端轮询默认 5s → 30s（实时性由 usage-updated 推送保证）。typecheck / 361 项单测 / build 全部通过。
- **dsh 插件模型来源升级三级 + 会话头状态缓存**：经 deepseek-harness 上游源码核实模型身份在 `data.message.source.model`（473/473 实测携带）而顶层 message.model 为 0 条；`request/header` 仅路由变化时稀疏写入（全文仅 1 条），旧两级来源在增量续读时状态丢失致用量永久漏采——现由三级来源 + per-file 会话头缓存（上限 512 近似 LRU、游标精确衔接才复用）消除盲区。typecheck / 361 项单测 / build 全部通过。
- **dsh 插件修复（早前轮次）**：用户真实数据诊断发现 `assistant/message` 均不携带 `message.model`（6084 条实测为 0），模型实际由 `request/header.data.header.config` 携带——插件改为 request/header 状态机供模 + message 自带优先的两级来源，真实数据端到端验证 6084/6084 全部产出、0 跳过。typecheck / 349 项单测 / build 全部通过。
