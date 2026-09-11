---
type: sync-design
title: 同步与去重
description: mtime 短路、行/字节/数据库编码游标、前缀状态恢复、主键与 requestId 去重、可替换成功快照和聚合重建。
tags: [sync, dedup, cursor, snapshot, mtime, chokidar, rollup]
resource: src/main/services/storage.ts
timestamp: 2026-09-11T12:03:38+08:00
---

# 同步与去重

> [!note] 当前状态
> 采集器以插件级有界并发执行，单插件内文件串行。2026-09-11 增加 schema v14 的 requestId 明细列与可替换快照事务，并更新多个插件的当前格式、前缀恢复、数据库水位和多根目录策略。验证基线：typecheck 两段、54 个测试文件 / 1166 个用例、生产构建均通过。

## 同步流程

1. 插件探测并列出只读输入文件或数据库。
2. 采集器读取 `sync_cursors`；游标 mtime 与当前 mtime 一致且均非 0 时直接短路。
3. 插件从 `line_offset` 继续解析；DSH zstd 额外使用 `byte_offset`。
4. 成功全零记录通常过滤，`status='error'` 的全零失败允许入库。
5. 计价后调用 `storage.recordUsage`，同事务写明细、去重账本和日/小时聚合。
6. 解析及入库成功后推进游标；单文件失败不推进该文件，并继续其他文件。
7. 实际插入或替换数量大于 0 时发送 `usage-updated`。

## 游标类型

| 类型 | 使用者 | 当前规则 |
|---|---|---|
| JSONL 行游标 | 多数日志插件 | `line_offset` 指向安全消费位置；尾部半行不推进。 |
| 前缀重建 + 行游标 | DSH 裸 JSONL、Copilot CLI、Command Code、Claude、Droid | 游标前缀只恢复状态或历史最佳快照，不重新产出；当前窗口才可新增或替换。 |
| zstd 字节游标 | DSH | `byte_offset` 只推进到完整帧末尾；重启缺内存状态时解压已消费前缀恢复 session/model。 |
| 数据库指纹 + rowid 编码水位 | OpenCode、DevEco、MiMo | 旧时间戳游标、数据库指纹变化或 rowid 回退触发从头重读；`message.id` 保证语义幂等。 |
| rowid/记录 ID 水位 | Zcode、Qoder 系、MiniMax 等 | 由各插件按已验证表结构维护；数据库重建策略以插件实现为准。 |
| 快照基线游标 | CodeWhale | 编码会话指纹与 `total_tokens` 基线；首次不回填、增长取差值、下降重置。 |
| current 数据库重读标志 | Kiro current | 数据库/WAL mtime 变化时重读 `conversations_v2`，同 turn 通过可替换快照收敛。 |

collector 的通用 truncate 判断会在文件 mtime 变化时把普通行游标重置为 0；插件若使用编码游标或内部基线，必须自行识别旧游标、文件身份和恢复策略。

## 文件监听与调度

- watcher 变更按插件定向触发 `collector.syncPlugin(id)`，500ms 防抖。
- Trae Agent 使用设置提供的多根目录动态注册 watcher；设置变化先卸载旧 watcher，再注册当前有效根。无配置时只兼容环境变量与旧默认候选，不扫描用户目录或磁盘。
- 定时扫描由 `syncIntervalMs` 控制，作为 watcher 之外的兜底。
- 首轮采集、定价同步、费用回填/重算和保留清理错峰启动，避免阻塞窗口创建。

## 两层不可变去重

### 文件行主键

普通记录内部 ID 为：

```text
<data_source>:<file_path>:<line>
```

`INSERT OR IGNORE` 保证同一证据位置重复读取不重复累计。

### 语义请求身份

有稳定 `source.requestId` 的记录将其持久化到 `usage_records.request_id`，并查写 `dedup_ledger(data_source, request_id)`。不可变记录命中同源 requestId 时保持 first-write-wins；无 requestId 的记录退回文件行主键。

requestId 规则必须逐源说明，不统计或编造“覆盖插件数量”。典型用途：

- gptme fork/branch 跨文件复制历史。
- Kilo 新旧存储迁移期间的稳定消息身份。
- MiniMax legacy/runtime 双库迁移重叠。
- Kiro current/legacy 同 turn 身份。

## 可替换成功快照

schema v14 允许少量插件把同一请求的中间成功快照修正为最终成功快照：

1. `usage_records` 已保存 `request_id` 与 `is_replaceable_snapshot`。
2. 新旧记录必须同 `data_source + request_id`，且二者均 `is_replaceable_snapshot=1`、`status='success'`。
3. 满足条件时保留原数据库主键，更新模型、四桶、费用、状态、项目/会话、证据路径/行号和时间。
4. 同事务重新聚合受影响的旧、新日桶与小时桶；跨日期、小时或模型时同时重建两侧桶，空桶删除。
5. 完全相同快照返回 0；有效替换返回 1，因此与新增记录一样触发 `usage-updated`。
6. 错误记录、不可替换记录、旧账本无法定位明细的情况均保持 first-write-wins。
7. 任一步失败时明细、ledger、日聚合和小时聚合整体回滚。

当前启用源：Claude 成功 message ID、Kiro current SQLite turn、Droid 成功 message ID。其他记录默认不可替换。

## 失败与全零记录

- `status='error'` 即使四桶全 0 也可入库；成功全零仍被过滤。
- `errorMessage` 入库前截断至 500 字符。
- `cancelled/interrupted` 由插件层忽略，不构造 error 记录。
- v9 曾全量清除游标用于回填历史失败；v14 不再次清游标，也不破坏既有明细。

## 已知边界

- OpenCode-like 已处理同时间戳晚插入、时间倒序和数据库 rowid 回退；保留同数据库身份和 rowid、仅原位修改历史行时不会重新产出。
- CodeWhale 首次启用不追溯历史；快照间模型切换无法还原。
- Cline/Roo 无 requestId 且无有效时间戳的旧记录只能退回数组索引。
- gptme fork/branch 缺稳定消息 ID 时不猜测内容关系。
- DSH 不解析未验证的未来版本、`.dsh` 容器或 SQLite 后端。

## 实时刷新

`recordUsage` 返回本批实际插入与有效替换数。大于 0 时 EventBus 以 200ms 防抖发送事件；渲染端再以 1500ms 防抖失效用量查询。完全相同快照、不可变语义去重命中和文件行主键冲突均不触发刷新。

## 关联页面

- [监控插件](monitor-plugins.md)
- [数据模型](data-model.md)
- [数据流](data-flow.md)
- [返回目录](../index.md)
