# 更新日志（按天）

> 仅保留最近 7 天。详细按小时记录见 [changelog/](changelog/)。

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

## 2026-08-23

- **pi / zcode / dsh 三监控插件接入（内置插件 5 → 8）**：pi（JSONL 树解析，semantics=2，requestId=条目 id）、zcode（SQLite rowid 水位 + WAL 感知，实测 input 含缓存 semantics=1）、dsh（fzstd 纯 JS 解压 zstd 帧解析 event-sourced JSONL，semantics=2，preview 格式声明）；AppType 扩至八值，契约/徽标/版本探测同步。typecheck / 346 项单测 / build 全部通过。
- **各 CLI 最新版日志格式核实与兼容**：联网核实五源——claude 当前版按 content block 逐行写 JSONL（共享 message.id、output 流式单调增长），插件新增 `foldById` 折叠消除约 2.4 倍高估；gemini 新版已迁移 append-only JSONL（首行 metadata + 消息行 + $set 更新行，subagent 嵌套目录），插件双格式兼容（chats 子树 .jsonl 任意层级 + legacy session-*.json 不变）；codex 经 codex-rs 源码定论 output_tokens 已含 reasoning（现有实现正确）、opencode/grok 无变化。typecheck / 297 项单测 / build 全部通过。
- **第五轮迭代（对标 cc-switch 用量统计）**：计费语义修复——`calcCost` 对 semantics=1 的 codex/gemini/grok 先扣缓存再计价（旧公式重复计费高估费用），opencode 存量标注由 v4 迁移修正为 2、三源历史费用经 `recalcCachedInputCosts` 启动重算；fork/rewrite 语义去重接入——五插件产出稳定 requestId、入库事务内查写 dedup_ledger；opencode WAL mtime 感知与清理前预回填；定价归一化 8 步 + 五级匹配链（effort 后缀剥离、点转横线变体、家族兜底）；前端自定义时间档、趋势图渐变、token 数量级中文本地化。typecheck / 286 项单测 / build 全部通过。

## 2026-08-22

- **第四轮迭代（时间范围五档 + 统计页精简 + 设置拆分）**：时间范围扩为 today/24h/7d/14d/30d 五档，today 与 24h 走小时聚合、其余按天（后端 LogFilters 纯时间戳过滤不变）；统计页「按模型」视图移除「应用」列；AppSettings 新增 statsRefreshIntervalMs（默认 5000）与 pricingSyncIntervalMs（默认 300000），价格自动同步间隔与渲染端轮询间隔均改为设置可配。typecheck / 222 项单测通过。
- **第三轮迭代（数据质量 + 定价自动化 + CLI 版本探测）**：全零 token 记录入库前统一拦截（游标照常推进）+ v3 迁移清洗存量脏明细并重建受影响日期日聚合；models.dev 定价改为每 5 分钟无条件自动同步（seed 仅离线兜底），定价页只读化、IPC 收窄至 17 方法；新增 CLI `--version` 探测并在监控源页展示；渲染端 5s 兜底轮询、固定侧边栏布局与深色滚动条。typecheck / 222 项单测通过。
- **AGENTS.md 精简重写**：改为紧凑指令文件，补充 pnpm 非 TTY 环境坑（`$env:CI='true'`）与单文件测试命令，删除与 docs/ 重复的低信号内容。

## 2026-08-21

- **代码-文档一致性审计**：重读全部核心源码核对概念页，修订 7 页（监控插件/插件体系/总体架构/数据流/同步去重/数据模型/定价），清除已消解的 `[!todo]`，删除与实现不符的描述；typecheck / 156 项单测复验通过。
