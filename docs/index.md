# Token Monitor 项目知识库

> 本知识库是项目的唯一设计依据。**第一阶段（插件化监控宿主 + 5 个内置监控插件）已于 2026-08-20 实现**。**2026-08-21 完成代码-文档一致性审计**；**2026-08-22 完成第二、三、四轮迭代并同步修订概念页**：第二轮——聚合查询优先读日聚合镜像、保留清理接线、前端实时刷新、今日小时桶后端化、grok 映射每轮重建、定价表 v2（source 三态分级覆盖，seed 99 条）、models.dev 同步、零成本回填、日志页筛选暴露、预算告警；第三轮——全零 token 记录入库拦截 + v3 存量清洗迁移、models.dev 定价全自动同步（seed 仅作离线兜底，定价页只读化、IPC 收窄至 17 方法）、CLI 版本探测（监控源页展示）、渲染端轮询与固定侧边栏布局；第四轮——时间范围扩为五档（today/24h/7d/14d/30d，today 与 24h 走小时聚合，其余按天）、统计页「按模型」视图移除应用列、统计刷新间隔与价格同步间隔改为设置可配（AppSettings 新增 statsRefreshIntervalMs / pricingSyncIntervalMs）。**2026-08-23 完成第五轮迭代（对标 cc-switch 用量统计）**：计费语义修复——`calcCost` 按 input_semantics 三态对 codex/gemini/grok 先扣缓存再计价（旧公式重复计费高估），opencode 存量标注由 v4 迁移修正为纯新输入、三源历史费用经 `recalcCachedInputCosts` 启动重算；fork/rewrite 语义去重接入——五插件产出稳定 requestId、入库事务内查写 dedup_ledger；opencode WAL mtime 感知与保留清理前预回填；模型归一化 8 步 + 五级匹配兜底链（effort 后缀剥离、点转横线变体精确前置、家族兜底）；前端自定义时间档、趋势图渐变面积、token 数量级中文本地化。同日完成**各 CLI 最新版日志格式联网复核与兼容**：claude 插件按 message.id 折叠流式分片（当前版每 content block 一行，逐行直录约 2.4 倍高估）、gemini 插件双格式兼容新版 append-only JSONL（legacy 单 JSON 不变）、codex 经源码定论 output 已含 reasoning 无需加速率、opencode/grok 核实无变化。同日**接入 pi / zcode / dsh 三个监控插件（内置插件 5 → 8）**：pi JSONL 树解析（disjoint 四桶，semantics=2）、zcode SQLite rowid 水位 + WAL 感知（实测 input 含缓存，semantics=1）、dsh fzstd 纯 JS 解压 zstd 帧解析 event-sourced JSONL（preview 格式声明）；新增依赖 fzstd。**2026-08-24 完成主进程防阻塞性能优化**（实测「每时每刻未响应」五源修复）：采集器 mtime 短路（游标与文件 mtime 一致且均非 0 时整文件跳过，`getCursorMeta` 接入）、watcher 定向同步（新增 `syncPlugin(id)` 只同步变更插件）、启动错峰（models.dev 同步 10s / 零成本回填 20s / 存量重算 30s 延迟触发）、定价写入批量化（seed 与 models.dev 同步收敛单事务批量 upsert，数千次 fsync → 1 次）、渲染端轮询默认 5s → 30s；同日 **dsh 插件模型来源升级三级 + per-file 会话头状态缓存**——经 deepseek-harness 上游源码核实模型身份在 `data.message.source.model`、`request/header` 仅路由变化时稀疏写入，增量续读漏采盲区由缓存消除（typecheck / 361 项单测 / build 通过）。**2026-08-25 修复 dsh 脏游标死锁（schema 升级至 v5）**：初版两级模型来源在真实数据上全部失效致解析零产出却推进满游标，mtime 短路又挡住历史文件重析，v5 迁移清除 dsh 会话文件游标触发全量重析自愈（实测 120/120 文件游标回写、6084 条 dsh 记录入库与上游 assistant/message 总数精确吻合、dedup_ledger 同步收敛、deepseek-v4-flash 定价全命中带费用，claude/codex/opencode/zcode 数据完好）。当前 typecheck / 27 文件 363 项单测 / build 全部通过。

## 目录

- [项目总览](concepts/overview.md) — 工具定位、技术栈与阶段性目标。
- [总体架构](concepts/architecture.md) — 插件宿主分层与模块职责。
- [插件体系](concepts/plugin-architecture.md) — 一切皆插件：注册表、服务容器、生命周期、事件。
- [监控插件](concepts/monitor-plugins.md) — `MonitorPlugin` 接口与 5 个内置插件实现清单。
- [数据流](concepts/data-flow.md) — 会话日志到用量统计的端到端处理链路。
- [数据模型](concepts/data-model.md) — SQLite 五张核心表结构设计。
- [同步与去重](concepts/sync-mechanism.md) — 增量游标、兜底扫描与去重策略。
- [定价与费用](concepts/pricing.md) — 模型定价表、费用计算、models.dev 自动同步与模型 ID 归一化。
- [UI 页面规划](concepts/ui-pages.md) — 渲染层页面与组件规划。
- [里程碑与风险](concepts/roadmap.md) — 实施路线图与待研究点。

## 维护说明

- `index.md` / `log.md` 为保留文件，不含 frontmatter。
- 变更记录见 [changelog](changelog/)（按小时合并）；每日摘要见 [log.md](log.md)。
- 维护规则与项目约定见根目录 `../AGENTS.md`。
