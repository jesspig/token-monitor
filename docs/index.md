# Token Monitor 项目知识库

> 本知识库是项目的唯一设计依据。**第一阶段（插件化监控宿主 + 5 个内置监控插件）已于 2026-08-20 实现**。**2026-08-21 完成代码-文档一致性审计**；**2026-08-22 完成第二、三、四轮迭代并同步修订概念页**：第二轮——聚合查询优先读日聚合镜像、保留清理接线、前端实时刷新、今日小时桶后端化、grok 映射每轮重建、定价表 v2（source 三态分级覆盖，seed 99 条）、models.dev 同步、零成本回填、日志页筛选暴露、预算告警；第三轮——全零 token 记录入库拦截 + v3 存量清洗迁移、models.dev 定价全自动同步（seed 仅作离线兜底，定价页只读化、IPC 收窄至 17 方法）、CLI 版本探测（监控源页展示）、渲染端轮询与固定侧边栏布局；第四轮——时间范围扩为五档（today/24h/7d/14d/30d，today 与 24h 走小时聚合，其余按天）、统计页「按模型」视图移除应用列、统计刷新间隔与价格同步间隔改为设置可配（AppSettings 新增 statsRefreshIntervalMs / pricingSyncIntervalMs）。当前 typecheck / 222 项单测全部通过。

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
