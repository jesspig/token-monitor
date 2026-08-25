# 更新日志（按天）

> 仅保留最近 7 天。详细按小时记录见 [changelog/](changelog/)。

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

## 2026-08-20

- **第一阶段开发完成**：插件化监控宿主 + 5 个内置监控插件（claude/codex/opencode/gemini/grok）端到端实现；typecheck / 156 项单测 / 构建 / electron-builder 打包全部通过。概念页状态更新为「已实现」，AGENTS.md 同步。

## 2026-08-19

- 建立项目知识库，确立**插件化监控架构**（一切皆插件）为设计方向；概念页定稿 10 页（总览/架构/插件体系/监控插件/数据流/数据模型/同步去重/定价/UI/里程碑），并建立 index、changelog 维护结构。
- **T13 渲染层基座**：落地 7 个页面 + 共享组件 + TanStack Query hooks + `api.ts`（RendererApi 门面，Mock 自动回退），`ui-pages.md` 状态更新为已实现。
