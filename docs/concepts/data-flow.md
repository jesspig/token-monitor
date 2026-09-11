---
type: data-flow
title: 数据流
description: 31 个插件的只读输入经多类游标解析、过滤、计价、不可变去重或可替换快照事务写入明细与日/小时聚合，再由 worker 查询和六页 UI 展示。
tags: [data-flow, pipeline, usage, sqlite, snapshot, worker]
resource: src/main/collector.ts
timestamp: 2026-09-11T12:03:38+08:00
---

# 数据流

> [!note] 当前状态
> 当前链路已覆盖 31 个插件、schema v14、可替换成功快照、OpenCode-like 编码水位和 Trae 多根设置。验证基线为 typecheck 两段、vitest 54 文件 / 1166 用例、`pnpm build` 全部通过。

## 端到端链路

```text
CLI 本地日志 / JSON 快照 / SQLite
  → 插件 detect + listFiles
  → mtime 短路
  → parseFile(fromLine / byteOffset)
  → 成功全零过滤；错误全零放行
  → pricing.calcCostBatch
  → storage.recordUsage
      ├─ 不可变插入：文件行主键 + requestId ledger
      └─ 可替换成功快照：更新原明细 + 重建受影响日/小时桶
  → sync_cursors 推进
  → usage-updated
  → worker 查询 usage_records / rollups
  → Dashboard / 日志 / 统计 / 定价 / 监控源 / 设置
```

## 采集阶段

1. 宿主只处理已启用插件。
2. watcher 变更定向触发单插件同步；定时器提供全量兜底。
3. mtime 与已存游标 mtime 一致且均非 0 时跳过未变化输入。
4. 插件解释自己的游标：
   - 普通 JSONL 行号。
   - DSH zstd 行号 + 帧字节偏移。
   - OpenCode/DevEco/MiMo 数据库指纹 + rowid 编码。
   - CodeWhale 会话指纹 + Token 基线。
   - Kiro current 的数据库重读标志。
5. DSH、Copilot CLI、Command Code、Claude、Droid 在需要时只读重放前缀恢复状态或最佳快照；前缀不重复产出。
6. 单文件解析失败保持原游标并继续其他文件。

## 数据质量和计价

- 成功记录四桶全 0 时不入库；错误记录即使全 0 仍保留。
- `inputSemantics=1` 时先从 input 扣除缓存读写再按价计算；0 不猜测，2 直接按纯新输入计价。
- 模型先归一化，再通过定价索引匹配；无定价时费用保持空，后续 models.dev 同步可回填。
- CodeWhale 只有会话总量，因此只在已建立基线后记录增长差值，不拆分未知四桶。
- Kiro 没有显式 Token 时拒绝字符数、credits 或 context 百分比估算。
- Droid settings 不参与 Token 或费用计算。

## 写入分流

### 不可变事件

绝大多数记录使用：

- 内部主键 `data_source:file_path:line`。
- 可选 `(data_source, request_id)` 语义账本。
- 重复证据位置或同源语义身份直接跳过。

### 可替换成功快照

Claude、Kiro current、Droid 的特定成功记录可标记 `isReplaceableSnapshot`。只有新旧均可替换且均 success 时更新；否则仍按 first-write-wins。

有效替换：

- 保留原数据库主键。
- 更新 Token、费用、模型、项目/会话、状态、证据位置和时间。
- 标记旧、新日桶及小时桶，从当前明细重新聚合。
- 更新 dedup ledger 指纹。
- 返回变更数 1 并触发 UI 刷新。

相同快照返回 0；事务失败整体回滚。

## 聚合与查询

- `usage_daily_rollups` 按 date/app/model 维护。
- `usage_hourly_rollups` 按 date/hour/app/model 维护。
- 无细维度筛选时优先读取聚合表。
- status/project/sessionId/keyword/httpStatus 等筛选回退明细。
- `getDailyModelBreakdown` 无维度筛选时读取日聚合，带维度时用 `(model, created_at)` 索引兜底。
- 查询通过只读 worker 池执行，主线程写入与 worker 读取由 WAL 隔离。

## 实时刷新

`recordUsage` 返回实际新增和有效替换数量。数量大于 0 时：

1. EventBus 200ms 防抖合并。
2. preload 向 renderer 推送 `usage-updated`。
3. `useUsageEvents` 1500ms 防抖失效用量 queryKey。
4. TanStack Query 重拉；相同 method+args 由 QueryClient in-flight 去重。

重复快照、不可变去重命中和主键冲突不发送刷新。

## 当前限制

- CodeWhale 首次启用不回填历史，且快照间模型切换不可还原。
- Cline CLI/SDK-managed 会话未接入。
- Droid settings 只验证格式，不计 Token。
- Kiro 当前库没有显式 Token 时直接不兼容，不估算。
- OpenCode-like 对保留相同数据库身份/rowid 的历史行原位更新不重新产出。
- 无稳定 requestId 的插件或记录只保证文件行级幂等。

## 关联页面

- [总体架构](architecture.md)
- [监控插件](monitor-plugins.md)
- [同步与去重](sync-mechanism.md)
- [数据模型](data-model.md)
- [UI 页面](ui-pages.md)
- [返回目录](../index.md)
