# 项目变更日志

> 仅保留当前日期向前 7 天内的摘要；详细记录位于 `docs/changelog/`。

## 2026-09-11

- **插件兼容性加固与 schema v14**：DSH 支持 legacy/v1/v2 JSONL/zstd；Kilo 接入 current `kilo.db` 并保留旧扩展；Kiro 接入 current `data.sqlite3` 并保留旧 sidecar；Copilot CLI、Command Code、Claude、Droid 增加前缀状态/快照恢复；gptme branches 与稳定消息 ID；Trae 设置页多根；CodeWhale 保守快照；OpenCode/DevEco/MiMo 数据库指纹+rowid；Cline/Roo 四编辑器根；MiniMax session/turn/id 语义身份。`usage_records` 新增 requestId 与可替换快照，Claude/Kiro current/Droid 按条件启用。typecheck 两段、vitest **54 文件 / 1166 用例**、build 全部通过。详见 [2026-09-11-12](changelog/2026-09-11-12.md)。
- **第三批 9 个监控源**：dev-eco/mimo/goose/copilot-cli/gptme/trae-agent/codewhale/droid/minimax 接入，内置插件扩至 31，schema 升至 v13。详见 [2026-09-11-03](changelog/2026-09-11-03.md)。

## 2026-09-10

- **第二批 14 个监控源**：内置插件由 8 扩至 22，schema v12 扩展缓存口径候选；知识库完成二次一致性校准。详见 [2026-09-10-03](changelog/2026-09-10-03.md) 与 [2026-09-10-20](changelog/2026-09-10-20.md)。
- **ECharts 与 UI/UX 系统化**：Recharts 迁移至 ECharts 6.1，QueryState/Toast/Toggle/useDismissable、语义 token、全局时间范围和布局修正落地。详见 [2026-09-10-00](changelog/2026-09-10-00.md)、[2026-09-10-01](changelog/2026-09-10-01.md)、[2026-09-10-02](changelog/2026-09-10-02.md)。

## 2026-09-09

- **死代码清理**：删除退役趋势页和零引用图表组件，同步修订 UI 文档。详见 [2026-09-09-23](changelog/2026-09-09-23.md)。
