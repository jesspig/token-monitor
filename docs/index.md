# Token Monitor 项目知识库

> `docs/` 是项目设计与实现事实的唯一文档来源。当前基线：Electron + TypeScript 本地 Token/费用监控工具；**31 个内置插件**；SQLite **schema v14**；6 个渲染页面；统计查询使用 2 个只读 worker；外部 CLI 日志和数据库只读。

## 2026-09-11 最新状态

完成插件兼容性加固与存储快照修正：

- DSH 支持 legacy 与 v1/v2 JSONL/zstd，并在重启时恢复前缀状态。
- Kilo 支持当前 `kilo.db` 与旧扩展；Kiro 支持 current `data.sqlite3` 与旧 sidecar。
- Copilot CLI、Command Code 通过前缀重建恢复累计或会话状态。
- gptme 发现 branches，并在有稳定消息 ID 时消除 fork/branch 复制历史。
- Trae Agent 设置页支持显式配置多个 trajectory 根。
- CodeWhale 使用保守快照：首次不回填，增长取差值，下降重置。
- OpenCode、DevEco、MiMo 改用数据库指纹 + rowid 编码水位。
- Cline、Roo 覆盖 VS Code Stable/Insiders、VSCodium、Cursor；Cline CLI 未接入。
- MiniMax 使用 session/turn/记录 id 组合语义身份处理双库重叠。
- schema v14 为 `usage_records` 增加 `request_id` 与可替换快照标记；Claude、Kiro current、Droid 按条件启用成功快照更新。
- Droid settings 只做发现、mtime 和格式验证，不计 Token。

验证证据：

- `pnpm typecheck` 两段通过。
- 全量 vitest：**54 个测试文件、1166 个用例通过**。
- `pnpm build` 通过。

完整记录见 [2026-09-11 12 时变更日志](changelog/2026-09-11-12.md)。

## 概念页

| 页面 | 内容 |
|---|---|
| [项目总览](concepts/overview.md) | 产品定位、技术栈与边界 |
| [总体架构](concepts/architecture.md) | 进程/线程边界、宿主工厂、schema v14 |
| [数据流](concepts/data-flow.md) | 采集、计价、不可变去重、快照修正、查询 |
| [数据模型](concepts/data-model.md) | 六表结构、v14、聚合与迁移 |
| [同步与去重](concepts/sync-mechanism.md) | 各类游标、mtime、requestId、可替换快照 |
| [监控插件](concepts/monitor-plugins.md) | 31 插件当前格式、身份与限制 |
| [插件体系](concepts/plugin-architecture.md) | registry/context/lifecycle/event-bus |
| [UI 页面](concepts/ui-pages.md) | 六页、ECharts、QueryState、Trae 多根设置 |
| [定价与费用](concepts/pricing.md) | 定价来源、模型匹配、输入语义与回填 |
| [里程碑与风险](concepts/roadmap.md) | 当前完成状态和证据驱动的后续方向 |

## 维护规则

- 改代码或行为前先读本索引及对应概念页。
- 文档与代码冲突时以当前代码和实际数据为准，并立即修正文档。
- 概念页修改时更新 frontmatter `timestamp` 为真实本机时间。
- 每次行为变更追加当前小时 changelog。
- `docs/log.md` 只保留最近 7 天摘要。
- 无法核实的内容明确标注，不把推断写成事实。
