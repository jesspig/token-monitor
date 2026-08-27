---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 8 个内置监控插件（claude/codex/opencode/gemini/grok/pi/zcode/dsh）实现清单；失败可观测性（T01 矩阵，status/errorMessage/httpStatus）。
tags: [plugin, monitor, cli, claude, codex, opencode, gemini, grok, pi, zcode, dsh, failure-observability]
resource: src/main/plugins/
timestamp: 2026-08-27T02:12:00+08:00
---

# 监控插件

> [!note] 当前状态
> **第一阶段 5 个内置插件已实现**（2026-08-20）：`src/main/plugins/{claude,codex,opencode,gemini,grok}.ts`，各有单测覆盖；解析格式均经联网核实。本页清单已按实际实现核对（2026-08-21）；CLI 版本探测于 2026-08-22 接入；语义请求 ID（requestId）与 opencode 语义标注修正/WAL 感知于 2026-08-23 接入；**claude 流式分片折叠与 gemini 新版 JSONL 双格式兼容于 2026-08-23 落地**（五源日志格式已按各 CLI 最新版联网复核）；**pi / zcode / dsh 三插件于 2026-08-23 接入，内置监控对象扩展至 8 个**（格式均经上游源码/社区实测核实）；**dsh 插件模型来源升级为三级 + 会话头状态缓存于 2026-08-24 落地**（经 deepseek-harness 上游源码核实：`assistant/message` 的模型身份在 `data.message.source.model` 而非顶层字段；`request/header` 仅路由/配置变化时稀疏写入——旧两级来源在增量续读时因状态丢失漏采用量，现由 per-file 缓存消除）；**2026-08-25 脏游标收尾**：初版两级来源在真实数据上全部失效（零记录产出却推进满游标），三级修复又被 mtime 短路挡住无法重析，最终由数据库 v5 迁移清除 dsh 会话文件游标触发全量重析自愈（120/120 文件、6084 条入库，见 [数据模型](data-model.md)）；**2026-08-26：dsh zstd 工件升级尾部帧级增量解压（scanZstdFrames + sync_cursors.byte_offset 字节游标），续读只解压新增帧而非整文件**；**同日防阻塞第二轮——dsh 解压下沉 worker_threads 单例线程（10s 超时销毁重建 + 异常环境恒主线程回退）、坏帧切割尝试上限 MAX_CUT_ATTEMPTS=8、pi/dsh detect 存在性短路、grok 映射 summary.json path:mtime 签名缓存**；**2026-08-27：失败请求可观测性接入（T01 矩阵，8 插件各自失败判定，status/errorMessage/httpStatus 全链路，见下方「失败判定」与 [数据模型](data-model.md) v8/v9、[同步与去重](sync-mechanism.md) 失败放行）**。

## `MonitorPlugin` 接口（实现于 shared/plugin.ts）

```ts
interface MonitorPlugin {
  id: AppType;               // 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok' | 'pi' | 'zcode' | 'dsh'
  name: string;              // 显示名
  version: string;           // 插件适配器版本（非被监控 CLI 的实际版本）
  deps?: ServiceKey[];       // 依赖服务，宿主按依赖解析装载顺序
  detect(ctx): Promise<Detection>;          // CLI 是否安装、会话目录是否存在
  listFiles(ctx): Promise<FileEntry[]>;      // { path, mtime }
  parseFile(ctx, path, fromLine): Promise<ParsedResult>; // 增量解析，返回新记录+新偏移
  dispose?(ctx): void;       // 卸载时清理监听/游标
}
```

`ParsedResult` 含 `records`、`nextLine`（游标推进）、`eof`（是否到文件尾）。8 个内置插件的 `deps` 均为 `['storage','pricing','events']`。`Detection` 另含可选 `cliVersion?: string | null` 字段（dto 层预留）。

## CLI 版本探测（已实现）

监控源页展示的「CLI 版本」与插件的 `version`（适配器自身版本）是两个概念：实际 CLI 版本由 `collector.getPluginStatus` 对每个插件**并行**调用 `src/main/services/cli-version.ts` 的 `detectCliVersion` 探测——

- 执行 `execFile <cli> --version`（超时 **3000ms**；win32 先经 `where.exe` 定位可执行文件再执行），取 stdout 首个非空行；
- 失败/超时返回 `null`，不抛错、不影响状态其余字段；
- 结果按命令名做进程级缓存（`clearCliVersionCache` 可清空），executor 可注入便于测试；
- 探测成功以可选字段 `PluginStatus.cliVersion` 返回，失败则字段缺省（UI 显示「未知」）。

## 内置插件清单（8 个，按实际实现）

| 插件 id | 数据根（可环境变量覆盖） | 扫描范围 | 解析源与关键字段 |
|---|---|---|---|
| claude | `~/.claude/projects` | 各编码项目目录直接子层 `*.jsonl` + 会话子目录内 `subagents/`、`workflows/` 子树递归 | 行 `type=="assistant"` 且含 `message.usage`：`input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`；`input_semantics=2`（纯新输入）；requestId = `message.id`（消息 UUID，fork/compact 后同消息散落多文件时可收敛）；**同批解析按 message.id 折叠流式分片**（当前版 Claude Code 每 content block 写一行：各行共享 message.id、input/cache 计数一致而 output 随流式单调增长，逐行直录约 2.4 倍高估——折叠保留 output 最大/最后一条） |
| codex | `~/.codex/sessions` | 全子树递归 `*.jsonl`(日期分区 `YYYY/MM/DD/` + `archived_sessions/`) | rollout JSONL 状态机解析：模型取 `turn_context.payload.model`,用量取 `event_msg(token_count).payload.info.last_token_usage`,cwd/sessionId 取 `session_meta`;`input_semantics=1`(input 含 `cached_input_tokens`,无 write 桶);**output 不加速率 reasoning_output_tokens**(经 codex-rs 源码定论:TokenUsage.output_tokens 原样取自 Responses API,官方口径已含 reasoning 子集明细,相加属双算);requestId = `<thread_id>:<行顶层timestamp>:<in>-<cached>-<out>` 组合键(token_count 无 per-event id;timestamp 用原串保证重写幂等) |
| opencode | `~/.local/share/opencode`（`$OPENCODE_HOME`） | 双源二选一：新版 `opencode.db`(SQLite) 单条目；否则旧版 `storage/message/*.json` + `storage/session/**/*.json` | 新版读 `message` 表（join `session.directory`），游标 = `time_created` 水位，data 列 `role=="assistant"` 的 `modelID / tokens{input,output,cache.read,cache.write}`；旧版每文件一条消息 JSON 同构解析；`input_semantics=2`（上游 getUsage 已自行扣减缓存，四项互不重叠——2026-08-23 修正，存量行由 v4 迁移改标）；requestId = db 行主键 `m.id`（旧版 JSON 为 data.id）；db 条目 mtime 取主库与 `-wal` 较大值（WAL 感知）。上游 schema 复核（2026-08-23）：message/session 表结构与 data 形态稳定 |
| gemini | `~/.gemini/tmp` | `<project_hash>/chats/` 子树：**新版 append-only JSONL**（PR #23749）任意层级收集（主会话 `session-*-*.jsonl` 在 chats 直接子层，subagent 为嵌套子目录下不带 session- 前缀的 `.jsonl`）+ legacy 单 JSON `session-*.json` 仅限 chats 直接子层 | `.jsonl` 逐行解析：首行 metadata（sessionId）建立会话状态、`$set` 更新行刷新、消息行 `type=="gemini"` 且含 model/tokens 产出（tokens 键名宽松兼容；`tokens.input=promptTokenCount` 含 cached，`input_semantics=1`）；尾部半行游标停驻重试。legacy `.json` 走原整体解析。两格式游标均为 1-based 行号增量；requestId = 消息 `id`（UUID） |
| grok | `~/.grok`（`GROK_HOME`） | `logs/unified.jsonl` + `sessions/**/summary.json` | unified.jsonl 行 `msg=="shell.turn.inference_done"`：`ctx.prompt_tokens / completion_tokens / cached_prompt_tokens`（prompt 含缓存读，无 write 桶，`input_semantics=1`）；requestId = `<sid>:<loop_index>` 组合键（会话内推理循环序号）；模型来自 summary.json `current_model_id` 建立的 sessionId→模型映射，**loadModelMap 按清单签名短路（2026-08-26）**：以 summary.json 清单的 `path:mtime` 拼接签名为准，未变化时复用上次映射、跳过全部重读重析；新增/变更 summary.json 改变签名，当轮即重建生效 |
| pi | `~/.pi/agent/sessions`（`$PI_CODING_AGENT_DIR` 覆盖根） | sessions 子树递归 `*.jsonl`（按工作目录编码层组织） | JSONL 树结构：首行 header `{type:'session', id, cwd}` 建立会话状态；`type==='message'` 且 `role==='assistant'` 且含 usage 的条目产出——usage 四桶 input/output/cacheRead/cacheWrite **互不重叠**，`input_semantics=2`；上游自带 usage.cost 不采用（统一本地计价）；requestId = 条目 `id`（fork 提取分支跨文件收敛）；compaction/model_change 等条目天然跳过 |
| zcode | `~/.zcode`（`$ZCODE_STORAGE_DIR` 重定位整个根） | 单数据源 `cli/db/db.sqlite`（SQLite 只读） | schema 核实自 CLI db v0.14.8（codeburn 实测）：`model_usage LEFT JOIN session` 取 directory；**input_tokens 已含缓存读写 → `input_semantics=1`**（直接计费约 8 倍高估）；reasoning_tokens 独立列不折入 output；时间戳 epoch 毫秒，createdAt = completed_at ?? started_at；游标 = **rowid 水位**（line=rowid 单调唯一）；WAL mtime max 感知；requestId = `model_usage.id`（每请求唯一） |
| dsh | `~/.dsh/sessions`（`$DSH_HOME` 覆盖 home） | 子树递归固定名工件 `session.jsonl.zstd` / `session.jsonl`（SQLite 后端 `.db` 暂不支持，detect reason 提示） | `.jsonl.zstd` 经 **fzstd（纯 JS zstd 解压）** 解压后逐行解析 event-sourced envelope `{type, seq, time, data}`（SESSION_FORMAT_VERSION=0 pre-release，破坏性变更时宽松解析+联网复核维护）；**zstd 尾部帧级增量解压（2026-08-26，scanZstdFrames，纯函数已提取至 src/main/workers/zstd-scan.ts）**：**解压经 worker_threads 单例 worker 执行（2026-08-26 防阻塞第二轮，入口 src/main/workers/zstd-worker.ts，构建产物 out/main/zstd-worker.js）**——懒创建；10s 超时（ZSTD_WORKER_TIMEOUT_MS）判定卡死即销毁重建并回退主线程同步 scanZstdFrames；创建失败/异常环境置 zstdWorkerBroken 标记恒走主线程回退（行为与线程化前一致）；插件 dispose 销毁 worker（vitest 无产物环境自动走同步路径）。首读从 0 起整流解压；续读（fromLine>1 且游标 `byte_offset` 为合法帧边界）仅解压新增压缩帧、片段首行全局行号 = fromLine——快路径整段交 fzstd 内建多帧循环（对帧内容伪 magic 免疫），失败（典型 = EOF 半帧正在写入）时从尾部倒序探测 magic 候选做安全切割点前缀解压（伪 magic 候选因真帧截断必然解压失败被自然排除；尝试上限 `MAX_CUT_ATTEMPTS = 8`，防最坏 O(n) 次 decompress），候选耗尽/超上限 → 真损坏游标不动；偏移非法/中途坏帧回退整块解压自愈并回填偏移；EOF 半帧只推进到最后完整帧末尾，其文本随补全后下轮产出；增量空文本短路不虚进行号。安全消费偏移经 setCursor 写回 `sync_cursors.byte_offset`（v6 列）；裸 .jsonl 无字节游标概念；`assistant/message` 且 data.usage 产出——TokenUsage disjoint 约定（inputTokens 不含缓存），`input_semantics=2`；reasoningTokens 为 output 子集不加速率；**模型三级来源：`data.message.source.model` 首选（上游 AssistantProvenance per-message 自带，473/473 实测全携带、增量续读永不丢）→ `data.message.model` 兜底（兼容上游未来恢复顶层字段，实测 0 条携带）→ 此前最近 request/header 的 `data.header.config.model` 状态机（header 仅在路由/配置变化时写入 reason ∈ initial/resume/change，远稀疏于计费条目）**；request/header 稀疏导致的增量续读状态盲区由模块级 **per-file 会话头状态缓存**消除（key=filePath，上限 512 条近似 LRU 淘汰：fromLine ≤ 1 全量重读时重置、与缓存 cursorLine 精确衔接时恢复 sessionId/project/currentModel 并于轮末连同 nextLine 写回、不衔接如文件被 truncate 时弃用重建）；requestId = `<sessionId>:<seq>`（fork seed 继承跨文件稳定）。已用真实数据端到端验证：6084/6084 全部产出、0 跳过 |

## 失败判定（已实现，2026-08-27，T01 矩阵 SSOT）

> 契约 SSOT：`shared/failure.ts`（常量与判定矩阵注释）与 `shared/dto.ts` 顶部矩阵注释为准，本节为面向实现的逐插件展开；`shared/failure.ts:ERROR_MESSAGE_MAX_LENGTH=500` 与 `IGNORED_FAILURE_STATUSES=['cancelled','interrupted']` 为截断与中断忽略的唯一来源。约束：`httpStatus` / `errorMessage` 仅 `status='error'` 时有效，成功/中断为 `undefined`（存储层为 `NULL`，见 [数据模型](data-model.md) v8）；`status` 缺省视为 `'success'`。

通用规则：HTTP 4xx/5xx、isApiErrorMessage、LLM failure、`status != completed/success` 即判 `error`；`cancelled` / `interrupted`（大小写不敏感，`isIgnoredFailureReason`）属用户中断，**忽略不计 error**——插件层不产出 error 记录，collector 不放行亦不入库，不触发失败告警与 rollup `error_count`。

| 插件 | 失败触发（任一即 error，互斥于 success） | httpStatus 来源 | errorMessage 来源（截断 500） | model / tokens / 备注 |
|---|---|---|---|---|
| **claude** | 行顶层 `isApiErrorMessage === true`（严格相等） | `apiErrorStatus`（有限数字才写入） | 优先顶层 `content[0].text`，其次 `message.content`（数组首块 text 或字符串），`trim` 非空才采用 | model = `message.model` 否则 `<synthetic>`（合成失败模型）；tokens 四项为 0，`inputSemantics=2`；本行**与 success 互斥**，优先于 `foldById` 折叠，失败记录不参与流式折叠（避免吞并）；`requestId = message.id`/`uuid`/`id` 三级回退 |
| **codex** | `payload.type === 'stream_error'`（`payload.type='turn_aborted'` 属 `interrupted` 忽略，返回 null） | `payload.codex_error_info.http_status_code`（兼容 `httpStatusCode`/`http_status`/`status_code` 驼峰/下划线，字符串数字亦兼容） | `payload.message`（宽松 string） | model = `state.model ?? 'unknown'`；tokens 四项 0，`semantics=1`；`requestId` 不设（codex stream_error 无稳定 id，退回主键去重）；`createdAt` 宽松：行 `timestamp` → `payload.timestamp/time` → `payload.info.time/timestamp` → `Date.now()` |
| **gemini** | 消息 `type === 'error'`（双格式均以该标记为准：legacy 单 JSON 的 `messages[]` 与新版 append-only JSONL 的消息行） | 不设（无精确码，存 `NULL`） | `content` / `text` / `message` / `error` / `errorMessage` 宽松提取（字符串或 `{text/content}` 数组拼接，`trim` 非空，`slice(0,500)`） | model = 前一条 `gemini` 消息的 `model` 回退，否则 `'unknown'`；tokens 四项 0，`semantics=1`；`lastModel` 由全量扫描维护（窗口外亦更新，保证增量续读时 error 能回退取到最近成功模型）；`requestId = msg.id` 透传；JSONL 解析中 `error` 与 `gemini` 共享 `sessionId/lastModel` 状态机，`inRange` 控制产出与游标 |
| **zcode** | `model_usage.status != 'completed' && error_type != null && error_type !== 'cancelled'`（精确判定，`cancelled` 忽略） | `error_code` 转数字（有限数保留，字符串数字兼容） | `error_message`（`trim` 非空，截断 500） | 行经 `SELECT m.*` 宽松兼容旧库缺列（缺字段时视为 success）；model 仍为 `model_id`；tokens 仍按原列取值（失败亦可带 token）；`semantics=1`；`requestId = model_usage.id`；`createdAt = completed_at ?? started_at ?? Date.now()` |
| **dsh** | `type === 'llm/retry' && data.failure` 为对象存在时（`llm/retry-started` 无 failure 属忽略，会话级中断亦忽略） | 不设（无精确码） | `[code] message` 拼接（`code/message` 取 `failure.code/message|error|text`，缺失时回退 `JSON.stringify(failure)`），`slice(0,500)` | model = `failure.model` / `data.model` / 缓存 `currentModel` 三级，否则 `'unknown'`；tokens 四项 0，`semantics=2`；`requestId = <sessionId>:<seq>` 与成功路径一致；`createdAt = envelope.time` |
| **grok** | 宽松探测：`msg=="shell.turn.inference_done"` 且存在 `error` 字段（`error/errorMessage/error_message` 任一非空）**或** `status != 'success'`（含数值 ≥400） | 宽松遍历 `row.httpStatus/http_status/http_status_code` / `ctx` 同名 / `statusCode` / 嵌套 `error` 对象内 `code/status` 等，首个有限数字 | 优先 `error`/`errorMessage` 字段（含对象内 `message/error/text/content` 或 `JSON.stringify` 回退），兜底 `status` 异常文案 | 中断忽略：任一候选文本含 `cancelled/canceled/interrupted` 即忽略（不产出，见 `isIgnoredText`）；失败时 `inputTokens/outputTokens/cacheRead` 保留原 `prompt_tokens/completion_tokens/cached_prompt_tokens`（如有）否则 0；`model` 仍取 `summary.json` 映射；`requestId = sid:loop_index` |
| **opencode** | 宽松探测：`data.error / errorMessage / error_message` 任一非空 **或** `status/state` 非 `success/completed/ok`（含数值 ≥400） | 宽松遍历 `data.httpStatus/http_status/statusCode/code` 及 `error` 对象内 / `dbExtra`（`SELECT m.*` 附加列 `error/http_status/status_code` 等） | 同 `errorMessage` 提取规则，`status` 异常时以 `status` 文案兜底 | 中断忽略同 grok（`cancelled/interrupted` 包含即忽略）；`tokens` 保留原值（如有）否则 0；`semantics=2`；`requestId` 三级 `opts.requestId > d.id > d.message.id`；db 路径 `SELECT m.*` 兼容未来 `error` 列，`dbExtra` 收集 `error/status/http_status` 等附加字段宽松传给探测 |
| **pi** | 宽松探测：`isError/is_error === true` **或** 存在 `error/errorMessage/error_message` **或** `status/state` 非 `success/completed/ok`（数值 ≥400） | 宽松遍历 `entry/msg` 的 `httpStatus/http_status/statusCode/code` 及嵌套 `error` 对象内 `code/status` | 同上，`status` 异常时以 `status` 文案兜底（`isError` 标记本身无文本亦查相邻文案） | 中断忽略同上；失败时 `model` 缺失则回退 `'unknown'`（成功路径要求 model 非空，失败宽松）；tokens 保留原 `usage.{input,output,cacheRead,cacheWrite}` 否则 0；`semantics=2`；`requestId = entry.id` |

补充约束（8 插件统一）：

- **零 token 放行**：失败记录即使 `input/output/cacheRead/cacheCreation` 四项全 0 亦经 `collector.isAllZeroUsage` 放行入库（`status==='error'` 时 `isAllZeroUsage` 返回 `false`），成功记录仍保持全零拦截（见 [同步与去重](sync-mechanism.md) 与 [数据流](data-flow.md)）。
- **截断位置**：插件层与 `storage.toUsageRecordRow` 双层截断 500（`ERROR_MESSAGE_MAX_LENGTH`），表格预览另截断 64，详情抽屉完整展示；`collector.truncateErrorMessage` 入库前再收敛一次。
- **性能**：8 插件失败分支均为追加的 `if` 字符串/对象字段宽松比较 + 单次 `slice(0,500)`，无正则/全表扫描，成功路径仅多一次相等比较，热点路径（JSONL 解析 / SQLite 扫描 / zstd 解压）零回退。

各插件共同行为：

- 文件过滤仅收 `*.jsonl` / `*.json` 候选（gemini 仅 `session-*`，grok 仅 `unified.jsonl` 与 `summary.json`，dsh 仅固定名 `session.jsonl[.zstd]`），排除临时/隐藏文件（`.tmp`、`.swp`、`.`前缀、`~`后缀）。
- requestId 宽松采用：string 且 trim 非空才写入 `source.requestId`；任一成分缺失时不设置（退回 `(file_path, line)` 主键去重），规则见 [同步与去重](sync-mechanism.md)。
- opencode 新版 db 源的「行号」为 `time_created` 水位派生的单调序号，跨轮去重唯一。
- 时间戳缺失/不可解析时兜底 `Date.now()`。
- 探测短路（2026-08-26 防阻塞第二轮）：pi / dsh 的 detect 以 `hasSessionFile` 存在性短路递归取代整树 listFilesFromRoot——找到首个会话文件即返回、不再逐文件 stat。

## 容错要求

- 文件被 CLI 写入中读到半行 → 丢弃末尾不完整行，游标停在最后完整行。
- 单文件解析失败不阻塞整体同步，记录错误并跳过。
- 对未知字段宽松解析（lenient parse），日志格式随版本演进不崩溃。

## 关联页面

- [插件体系](plugin-architecture.md) — 插件如何被宿主装载。
- [总体架构](architecture.md) — plugins 模块归属。
- [同步与去重](sync-mechanism.md) — 游标如何与 parseFile 协同。
- [返回目录](../index.md)