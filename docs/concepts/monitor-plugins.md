---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 31 个内置监控插件实现清单——首批 8 源（claude/codex/opencode/gemini/grok/pi/zcode/dsh）+ 第二批 14 源（workbuddy/codebuddy/cline/roo-code/kilo-code/qwen/qoder/qoder-cn/kimi/zed/kiro/reasonix/command-code/copilot-chat）+ 第三批 9 源（dev-eco/mimo/goose/copilot-cli/gptme/trae-agent/codewhale/droid/minimax）；失败可观测性（T01 矩阵，status/errorMessage/httpStatus，覆盖首批 8 源）。
tags: [plugin, monitor, cli, claude, codex, opencode, gemini, grok, pi, zcode, dsh, failure-observability, workbuddy, codebuddy, cline, roo-code, kilo-code, qwen, qoder, kimi, zed, kiro, reasonix, command-code, copilot-chat, dev-eco, mimo, goose, copilot-cli, gptme, trae-agent, codewhale, droid, minimax, opencode-like]
resource: src/main/plugins/
timestamp: 2026-09-11T03:05:47+08:00
---

# 监控插件

> [!note] 当前状态
> **第一阶段 5 个内置插件已实现**（2026-08-20）：`src/main/plugins/{claude,codex,opencode,gemini,grok}.ts`，各有单测覆盖；解析格式均经联网核实。本页清单已按实际实现核对（2026-08-21）；CLI 版本探测于 2026-08-22 接入；语义请求 ID（requestId）与 opencode 语义标注修正/WAL 感知于 2026-08-23 接入；**claude 流式分片折叠与 gemini 新版 JSONL 双格式兼容于 2026-08-23 落地**（五源日志格式已按各 CLI 最新版联网复核）；**pi / zcode / dsh 三插件于 2026-08-23 接入，内置监控对象扩展至 8 个**（格式均经上游源码/社区实测核实）；**dsh 插件模型来源升级为三级 + 会话头状态缓存于 2026-08-24 落地**（经 deepseek-harness 上游源码核实：`assistant/message` 的模型身份在 `data.message.source.model` 而非顶层字段；`request/header` 仅路由/配置变化时稀疏写入——旧两级来源在增量续读时因状态丢失漏采用量，现由 per-file 缓存消除）；**2026-08-25 脏游标收尾**：初版两级来源在真实数据上全部失效（零记录产出却推进满游标），三级修复又被 mtime 短路挡住无法重析，最终由数据库 v5 迁移清除 dsh 会话文件游标触发全量重析自愈（120/120 文件、6084 条入库，见 [数据模型](data-model.md)）；**2026-08-26：dsh zstd 工件升级尾部帧级增量解压（scanZstdFrames + sync_cursors.byte_offset 字节游标），续读只解压新增帧而非整文件**；**同日防阻塞第二轮——dsh 解压下沉 worker_threads 单例线程（10s 超时销毁重建 + 异常环境恒主线程回退）、坏帧切割尝试上限 MAX_CUT_ATTEMPTS=8、pi/dsh detect 存在性短路、grok 映射 summary.json path:mtime 签名缓存**；**2026-08-27：失败请求可观测性接入（T01 矩阵，8 插件各自失败判定，status/errorMessage/httpStatus 全链路，见下方「失败判定」与 [数据模型](data-model.md) v8/v9、[同步与去重](sync-mechanism.md) 失败放行）**；**2026-09-10：第二批 14 个监控数据源接入，内置监控对象扩展至 22 个**（workbuddy/codebuddy/cline/roo-code/kilo-code/qwen/qoder/qoder-cn/kimi/zed/kiro/reasonix/command-code/copilot-chat，类型/DB 层同日预登记、v12 迁移扩展七源缓存口径索引，详见下方「第二批数据源」章节）；失败判定 T01 矩阵当前覆盖首批 8 源，新 14 源按宽松解析不产出 error 记录；**2026-09-11：第三批 9 个监控数据源接入，内置监控对象扩展至 31 个**（dev-eco/mimo/goose/copilot-cli/gptme/trae-agent/codewhale/droid/minimax）——12 候选联网侦察（多数源码级核实），cursor-cli/antigravity/crush 三源 NO-GO 排除（见下方「第三批侦察排除」）；db v13 迁移扩展 cached_input 部分索引至十源（见 [数据模型](data-model.md)）；opencode 解析内核抽取为 `src/main/plugins/_lib/opencode-shared.ts`（`createOpencodeLikePluginCore` 工厂）供 opencode 同构 fork（dev-eco/mimo）复用，详见下方「第三批数据源」章节；第三批 9 源同第二批按宽松解析不产出 error 记录，未接入 T01 矩阵；vitest 全量 1061 用例通过。

## `MonitorPlugin` 接口（实现于 shared/plugin.ts）

```ts
interface MonitorPlugin {
  id: AppType;               // AppType 联合（shared/app.ts）31 个监控对象之一
  name: string;              // 显示名
  version: string;           // 插件适配器版本（非被监控 CLI 的实际版本）
  deps?: ServiceKey[];       // 依赖服务，宿主按依赖解析装载顺序
  detect(ctx): Promise<Detection>;          // CLI 是否安装、会话目录是否存在
  listFiles(ctx): Promise<FileEntry[]>;      // { path, mtime }
  parseFile(ctx, path, fromLine): Promise<ParsedResult>; // 增量解析，返回新记录+新偏移
  dispose?(ctx): void;       // 卸载时清理监听/游标
}
```

`ParsedResult` 含 `records`、`nextLine`（游标推进）、`eof`（是否到文件尾）。31 个内置插件的 `deps` 均为 `['storage','pricing','events']`（workbuddy/codebuddy 经 `createBuddyPlugin` 工厂、qoder/qoder-cn 经 `_lib/qoder-shared`、dev-eco/mimo 经 `_lib/opencode-shared` 共享内核产出，deps 一致）。`Detection` 另含可选 `cliVersion?: string | null` 字段（dto 层预留）。

## CLI 版本探测（已实现）

监控源页展示的「CLI 版本」与插件的 `version`（适配器自身版本）是两个概念：实际 CLI 版本由 `collector.getPluginStatus` 对每个插件**并行**调用 `src/main/services/cli-version.ts` 的 `detectCliVersion` 探测——

- 执行 `execFile <cli> --version`（超时 **3000ms**；win32 先经 `where.exe` 定位可执行文件再执行），取 stdout 首个非空行；
- 失败/超时返回 `null`，不抛错、不影响状态其余字段；
- 结果按命令名做进程级缓存（`clearCliVersionCache` 可清空），executor 可注入便于测试；
- 探测成功以可选字段 `PluginStatus.cliVersion` 返回，失败则字段缺省（UI 显示「未知」）。

## 内置插件清单（31 个 = 首批 8 个 + 第二批 14 个 + 第三批 9 个，按实际实现）

首批 8 源详表如下；第二批 14 源于 2026-09-10 接入，逐源实现说明见下方「第二批数据源」章节；第三批 9 源于 2026-09-11 接入，见「第三批数据源」章节。

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

## 第二批数据源（14 个，已实现，2026-09-10）

2026-09-10 预登记并同日落地：`shared/app.ts` 的 `AppType` 联合、`src/main/services/cli-version.ts` 的 `CLI_VERSION_COMMANDS`、`src/renderer/src/lib/format.ts` 的 `APP_META` 各补齐 14 键；`src/main/services/db.ts` v12 迁移将 `idx_usage_records_cached_input` 部分索引扩展至 `('codex','gemini','grok','workbuddy','codebuddy','qwen','reasonix')`，`src/main/services/pricing.ts` 的 `recalcCachedInputCosts` 选中 SQL 同步扩展；插件文件（`src/main/plugins/<id>.ts`，各配单测）与 `src/main/host.ts` 的 `BUILTIN_PLUGINS` 22 项登记完成。本节记录各源实现要点，semantics 取值：**1 = input 含缓存总量需扣减**、**2 = 纯新输入**、**0 = 未知**（与 `usage_records.input_semantics` 一致，见 [数据模型](data-model.md)）。14 源 semantics 分配汇总：**1** = workbuddy / codebuddy / qwen / reasonix；**2** = cline / roo-code / kilo-code / kimi / zed / command-code / copilot-chat；**0** = qoder / qoder-cn / kiro。

### WorkBuddy（`workbuddy`，已实现）

- **数据位置**：`%USERPROFILE%\.workbuddy\projects\**\*.jsonl`；*nix `~/.workbuddy/projects/`；含 `<sessionId>/subagents/` 子目录与平铺两种布局，均扫描；`WORKBUDDY_DIR` 覆盖（语义 = **projects 目录**本身）
- **格式**：JSONL；`input_semantics=1`（input 保留含缓存原始量，计费前扣减）
- **关键字段**：与 CodeBuddy 共享解析内核 `src/main/plugins/_lib/tencent-buddy.ts`（`createBuddyPlugin` 工厂仅换 appType/根目录/环境变量名）；两种 usage 形态并存——`message.usage`（Anthropic 形态：`input_tokens / output_tokens / cache_read_input_tokens`）与 `function_call.providerData.rawUsage`（GLM 形态：`prompt_tokens / completion_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens / cache_read_input_tokens / cache_creation_input_tokens / completion_thinking_tokens`）；`rawUsage.prompt_tokens` 含缓存命中量（semantics=1 依据）；同 requestId 记录按 total 大者折叠（防汇总行与明细行双计）

### CodeBuddy / CLI 与 IDE（`codebuddy`，已实现）

- **数据位置**：`%USERPROFILE%\.codebuddy\projects\{project-key}\{sessionId}.jsonl`；*nix `~/.codebuddy/projects/`；布局同 WorkBuddy（`subagents/` 子目录 + 平铺）；`CODEBUDDY_DIR` 覆盖（语义 = projects 目录）；忽略 `~/.codebuddy/code-ratio/` 下的 watcher 文件
- **格式**：JSONL；`input_semantics=1`
- **关键字段**：与 WorkBuddy 同源格式（CLI 与 IDE 共用——IDE 经 ACP 落同一目录），共用 `_lib/tencent-buddy.ts` 内核与「同 requestId 按 total 大者折叠」去重

### Cline（`cline`，已实现）

- **数据位置**：`%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<id>\ui_messages.json`；*nix `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/`；`CLINE_DIR` 覆盖（语义 = **完整的 globalStorage 目录**）
- **格式**：JSON 数组，**整体重写而非追加**；`input_semantics=2`（官方源码证实 `tokensIn` 为不含缓存的独立桶，与 cacheWrites/cacheReads 互斥）
- **关键字段**：`say:"api_req_started"` 条目的 `text` 为字符串化 JSON `{tokensIn, tokensOut, cacheWrites, cacheReads, cost}`；解析策略为**全量重析 + requestId 幂等去重**——requestId = `String(ts)`（`api_req_started` 条目 ts，整体重写下行号不稳定）；文件含未回填的占位条目（cost/字段缺失）时**游标归零等待回填**，下轮整文件重析；model 三级来源：条目 `modelInfo.modelId` → 同目录 `api_conversation_history.json` 反查 → 均无则该条目不产出

### Roo Code（`roo-code`，已实现）

- **数据位置**：`%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks\<id>\ui_messages.json`；*nix `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/`；`ROO_CODE_DIR` 覆盖（语义同 CLINE_DIR）
- **格式**：同 Cline（JSON 数组整体重写）；`input_semantics=2`
- **关键字段**：壳复用 cline 插件导出的解析内核（`detectClineLikeTasks` / `listClineLikeTaskFiles` / `parseUiMessages` / `loadHistoryModel`），仅换 extensionId（`rooveterinaryinc.roo-cline`）与环境变量（`ROO_CODE_DIR`），解析行为与 Cline 完全一致

### Kilo Code（`kilo-code`，已实现）

- **数据位置**：`%APPDATA%\Code\User\globalStorage\kilocode.kilo-code\tasks\<uuid>\ui_messages.json`；*nix `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/`；`KILO_CODE_DIR` 覆盖（语义同 CLINE_DIR）
- **格式**：同 Cline（JSON 数组整体重写）；`input_semantics=2`
- **关键字段**：壳复用 cline 内核（extensionId `kilocode.kilo-code`、`KILO_CODE_DIR`），与 Roo Code 同构

### Qwen Code（`qwen`，已实现）

- **数据位置**：`~/.qwen/usage/token-usage-<YYYY-MM>.jsonl`（Windows：`%USERPROFILE%\.qwen\usage\`），按月分文件；目录覆盖优先级 `QWEN_RUNTIME_DIR > QWEN_HOME > ~/.qwen`
- **格式**：JSONL，逐 API 响应一行；`input_semantics=1`（源码证实 `inputTokens` 已含 `cachedTokens`，计费前扣减）
- **关键字段**：行字段 camelCase——`schemaVersion / id(uuid) / timestamp(ISO) / sessionId / model / authType / source / inputTokens / outputTokens / cachedTokens / thoughtsTokens / totalTokens / apiDurationMs`；requestId = 行 `id`；文件产出受 `usageStatisticsEnabled` 设置门控（关闭时不落盘，detect 容忍目录缺失）

### Qoder（`qoder`，已实现）

- **数据位置**：多候选路径按序探测——桌面布局 `%APPDATA%\Qoder\SharedClientCache\cache\db\local.db` 与 `~/.qoder/shared_client/cache/db/local.db`（*nix 同构）；`QODER_DIR` 覆盖（覆盖根下同时探测 `SharedClientCache\cache\db` 与 `shared_client/cache/db` 两种布局）
- **格式**：SQLite **明文**（readonly 打开），`chat_message` 表；`input_semantics=0`（官方采集器对 `prompt_tokens` 无扣减证据，与 `cached_tokens` 的包含关系存疑，无法确认前保持 0）
- **关键字段**：`role='assistant'` 行——`token_info`（JSON 字符串：`prompt_tokens / completion_tokens / cached_tokens`）、`request_id`（requestId，并以此 JOIN `chat_record` 取 `extra.modelConfig.key`）、model 两级：`model_info.model_key` → 回退 `chat_record.extra.modelConfig.key`；`gmt_create` 毫秒时间戳；游标 = **rowid 水位**

### Qoder CN（`qoder-cn`，已实现）

- **数据位置**：三候选路径按序探测——`~/.qoder-cn/shared_client/cache/db/local.db`、`%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`、`%APPDATA%\Qoder CN\SharedClientCache\cache\db\local.db`；`QODER_CN_DIR` 覆盖（覆盖根下同样三布局探测）
- **格式**：SQLite（readonly），同 Qoder（共享内核 `src/main/plugins/_lib/qoder-shared.ts`）；`input_semantics=0`
- **关键字段**：同 Qoder（`chat_message` 表 / `token_info` / model 两级 / `gmt_create` / rowid 游标）

### Kimi Code（`kimi`，已实现）

- **数据位置**：`~/.kimi-code/sessions\<workspace>\<sessionId>\agents\<agent>\wire.jsonl`（Windows：`%USERPROFILE%\.kimi-code\sessions\`）；`KIMI_CODE_HOME` 覆盖
- **格式**：JSONL；`input_semantics=2`（纯新输入，input 与 cache 桶互斥）
- **关键字段**：仅取 `type=="usage.record"` 且 `usageScope=="turn"` 的行（`step.end` / session 汇总行排除，防双计）；usage 桶为 camelCase `inputOther / output / inputCacheRead / inputCacheCreation`（snake_case `input_other / input_cache_read / input_cache_creation` 为旧版 kimi-cli 形态，取值双名兼容）；`model / time`（毫秒）；行级无稳定 id，不设 requestId，靠 `(file_path, line)` 主键幂等

### Zed（`zed`，已实现）

- **数据位置**：`%LOCALAPPDATA%\Zed\threads\threads.db`（win32）；*nix `~/.local/share/zed/threads/threads.db`；`ZED_DIR` 覆盖（语义 = **数据根**，库在其下 `threads.db`）
- **格式**：SQLite（只读），`threads.data` 列为 zstd 压缩 JSON 或明文（按魔数判定）；`input_semantics=2`（逐请求四桶互斥）
- **关键字段**：`data` 解压后取 `request_token_usage`：`input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`（四桶互斥，semantics=2 依据）；解压复用项目 fzstd 依赖（zstd 帧），单条解压上限 **32MB**（`MAX_THREAD_JSON_BYTES`）；仅统计 provider 为 `zed.dev` 的行（大小写不敏感；外部 provider 由各自插件统计避免双算）、排除 imported 会话；requestId = `<threadId>:<usage 键>`；**Zed 写库走 ON CONFLICT UPDATE、rowid 不变——插件用双水位游标：`line_offset` 存 rowid，`byte_offset` 复用为 updated_at 毫秒水位**（updated_at 变化的行即使 rowid 低于水位也重析， requestId 幂等去重收敛）；条目无时间戳时按 thread 级 `created_at → updated_at → JSON.updated_at` 链回退

### Kiro CLI（`kiro`，已实现）

> [!todo] 待验证
> explicit 计数当前恒 0（服务端未下发），待真实数据回填验证。

- **数据位置**：`%USERPROFILE%\.kiro\sessions\cli\`；*nix `~/.kiro/sessions/cli/`；`KIRO_DIR` 覆盖
- **格式**：枚举与游标挂 `.jsonl` 转录文件（过滤 `.lock` / `.history` 附属文件），但 **`.jsonl` 行内不含 token 字段**——usage 唯一落点是伴生 `<session>.json` sidecar 的 `session_state.conversation_metadata.user_turn_metadatas[]`（`input_token_count / output_token_count / end_timestamp`）；`input_semantics=0`（来源无语义声明）
- **关键字段**：解析读 sidecar、仅统计 explicit 实测值——**当前社区实测服务端下发恒 0，记录稀少属预期**（项目决策禁止推算，不做任何估算回退，全零 turn 不产出）；model = 会话级 `rts_model_state.model_info.model_id`（缺失时游标不动等待回填）；requestId = `<sessionId>:<turnIndex>`

### Reasonix（`reasonix`，已实现）

- **数据位置**：`%APPDATA%\reasonix\stats\YYYY-MM-DD.jsonl`（按天分文件）；*nix `~/.reasonix/stats/`；路径优先级 `REASONIX_STATE_HOME > REASONIX_HOME > 平台默认`（官方 CONFIG_PATHS.md v1.8.1+）
- **格式**：JSONL；`input_semantics=1`（官方 run_metrics.go 费用公式仅对 cache_hit / cache_miss / completion 三桶计价，证实 `prompt = cache_hit + cache_miss` 为含缓存总量，计费前扣减）
- **关键字段**：逐请求一条：`ts / model / prompt / completion / reasoning / cache_hit / cache_miss`；usage 唯一落点为 stats 文件（会话文件不带用量）；`turn:true` 行（轮汇总）跳过防双计

### Command Code（`command-code`，已实现）

- **数据位置**：`%USERPROFILE%\.commandcode\projects\<slug>\<session>.jsonl`；*nix `~/.commandcode/projects/`；`COMMANDCODE_DIR` 覆盖（官方无该环境变量机制，属本项目测试钩子）
- **格式**：JSONL v3 类型化事件流；`input_semantics=2`（usage 四桶 DISJOINT）；扫描跳过 `*.checkpoints.jsonl`
- **关键字段**：assistant 行 `usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}`；requestId = `<id>:<timestampMs|-1>`（tokscale 同款组合键，无时间戳时以 `-1` 哨兵）；rewind 产生树状孤儿分支——叶链回溯只保留活跃分支（断链 fail open 全保留），同 requestId 多行靠 dedup_ledger 语义去重；model 三级来源：行 `model` → `model_change` 事件回溯 → `'unknown'`

### Copilot Chat（`copilot-chat`，已实现）

- **数据位置**：双位置——`%APPDATA%\Code\User\globalStorage\emptyWindowChatSessions\*.jsonl` 与 `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.jsonl`；*nix 对应 `~/.config/Code/User/` 同构路径；`COPILOT_CHAT_DIR` 覆盖（语义 = **VS Code User 目录**）
- **格式**：JSONL chat storage v3 patch 增量流（kind=0 header / kind=1 路径赋值 / kind=2 数组追加，需顺序合并重建状态）；`input_semantics=2`
- **关键字段**：usage 为 `requests` 条目的 `promptTokens / completionTokens`（patch 演进取终值；全量重析 + requestId 幂等去重应对行号漂移）；model = `modelId` 原样保留（`copilot/claude-haiku-4.5` 等，不走归一化前的猜测）；无 cache 桶（四桶记 0）、无 cost（费用走本地定价）；latencyMs = `elapsedMs`；格式已基于本机 2026-09 实测样本核验（404 个会话文件、171 个真实请求条目）

## 第三批数据源（9 个，已实现，2026-09-11）

2026-09-11 落地：`shared/app.ts` 的 `AppType` 联合、`src/main/services/cli-version.ts` 的 `CLI_VERSION_COMMANDS`、`src/renderer/src/lib/format.ts` 的 `APP_META` 各补齐 9 键；`src/main/services/db.ts` v13 迁移将 `idx_usage_records_cached_input` 部分索引 DROP 后按十源重建（原七源 + `goose`/`copilot-cli`/`trae-agent`），`src/main/services/pricing.ts` 的 `recalcCachedInputCosts` 选中 SQL 同步扩为十源；插件文件（`src/main/plugins/<id>.ts`，各配单测）与 `src/main/host.ts` 的 `BUILTIN_PLUGINS` 31 项登记完成。本轮接入前对 12 候选做联网侦察（多数源码级核实），cursor-cli/antigravity/crush 三源 NO-GO 排除（见下方「第三批侦察排除」）；**opencode 解析内核抽取为 `src/main/plugins/_lib/opencode-shared.ts`**（`createOpencodeLikePluginCore` 工厂：db/JSON 双解析器、`time_created` 水位游标、失败探测、250ms busy 短超时），opencode 主插件与同构 fork 共用。第三批 9 源同第二批：宽松解析、不产出 error 记录，未接入 T01 失败判定矩阵。semantics 取值约定同上节。9 源 semantics 分配汇总：**1**（input 含缓存总量需扣减）= goose / copilot-cli（整体）；**2**（纯新输入）= dev-eco / mimo / gptme / droid / minimax（整体）；**0**（未知）= codewhale；**trae-agent 行级混合**（provider=anthropic → 2，openai/google/azure/doubao/openrouter/ollama 等 → 1，源自各 client 映射源码）。

### DevEco Code（`dev-eco`，已实现）

- **数据位置**：`~/.local/share/deveco`（Windows `%USERPROFILE%\.local\share\deveco`，xdg-basedir 回退同构）；`DEVECO_DIR` 覆盖（测试钩子兼根覆盖）、`XDG_DATA_HOME` 间接生效（其下 `deveco`）、`DEVECO_DB` 整体覆盖 db 文件；候选 `deveco.db` + `deveco-beta.db` / `deveco-prod.db` 通道变体
- **格式**：SQLite（只读，250ms busy 短超时），与 opencode.db **完全同构**（华为 opencode fork，源码级核实：message/part/session 表结构与 data JSON 逐字段一致）
- **关键字段**：复用 `_lib/opencode-shared.ts` 内核（`createOpencodeLikePluginCore` 工厂，appType 换 `dev-eco`）；`input_semantics=2`；requestId = message.id；游标 = `time_created` 水位；条目 mtime 取主库与 `-wal` 较大值（WAL 感知）

### MiMo Code（`mimo`，已实现）

- **数据位置**：`~/.local/share/mimocode`（Windows 同构）；`MIMOCODE_HOME` 覆盖时布局多一层 `data/`（`$MIMOCODE_HOME/data/mimocode.db`），插件双布局探测并合并列出；`MIMOCODE_DB` 整体覆盖 db 文件；`MIMO_DIR` 覆盖数据根（测试钩子）；候选 `mimocode.db` + `mimocode-beta.db` / `mimocode-prod.db` 变体
- **格式**：SQLite（只读，250ms busy 短超时），opencode 同构（小米 fork，源码级核实）
- **关键字段**：同 dev-eco——复用 `_lib/opencode-shared.ts` 共享内核，`input_semantics=2`，requestId = message.id，`time_created` 水位游标，WAL mtime 感知

### Goose（`goose`，已实现）

- **数据位置**：`~/.local/share/goose/sessions/sessions.db`（Windows `%APPDATA%\Block\goose\data\sessions\sessions.db`）；`GOOSE_PATH_ROOT` → 其下 `data/sessions`；`GOOSE_DIR` 覆盖 sessions 目录（测试钩子）
- **格式**：SQLite（WAL，只读，250ms busy 短超时），核心表 `usage_ledger`（schema v15+，每轮 LLM 调用一行）：`id / session_id / created_timestamp（unix 秒）/ model / input_tokens / output_tokens / total_tokens / cache_read_tokens / cache_write_tokens / cost / cost_source / is_compaction`
- **关键字段**：**PRAGMA `table_info` 列探测防御**（8 必需列缺失即空处理、游标不动，兼容上游 schema 演进）；`input_semantics=1`（官方 rustdoc 证实 input 含缓存读写总量，计费前框架扣减）；游标 = rowid（`id`）水位；model 空兜 `'unknown'`；`is_compaction` 行照常产出（压缩亦是真实消耗）；不设 requestId（rowid 主键幂等）；旧版 per-会话 JSONL（v1.10 前）无逐轮 token，未纳入

### Copilot CLI（`copilot-cli`，已实现）

- **数据位置**：`~/.copilot/session-state/<session-uuid>/events.jsonl`；`COPILOT_HOME` / `COPILOT_CONFIG_DIR` 双变量探测（其下 `session-state`）、`COPILOT_DIR` 覆盖（测试钩子兼根覆盖）
- **格式**：append-only JSONL 事件流（`{type, data, id, parentId, timestamp}`），**usage 唯一落点 `type=="session.shutdown"`** 的 `data.modelMetrics`（键 = 模型 id 原样保留含 `-1m` 后缀；usage 四桶 camelCase `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`）
- **关键字段**：`inputTokens` 含两缓存桶 → `input_semantics=1`；**累计快照语义**（resume 后新 shutdown 的 modelMetrics 包含历史轮次）→ 模块级 per-file **delta 状态机**（`Map<filePath, {cursorLine, Map<model, 四桶水位>}>`，上限 512 近似 LRU、游标精确衔接才复用），每次 shutdown 只产出超出上次水位的增量，杜绝 resume 双计；requestId = `<事件 id | timestamp | 行号>:<model>`；全零增量跳过不产出

### gptme（`gptme`，已实现）

- **数据位置**：`~/.local/share/gptme/logs/<conversation>/conversation.jsonl`；`GPTME_LOGS_HOME` 重定向；`GPTME_DIR` 覆盖（测试钩子兼根覆盖）
- **格式**：JSONL，assistant 行 `metadata` 双形态——新版嵌套 `metadata.usage` / 旧版扁平整个 metadata，按官方聚合取法（`usage` 为非空对象则用之，否则取整个 metadata）
- **关键字段**：`input_semantics=2`（官方注释明确 input 不含缓存，与 cache 两桶互斥）；无 requestId（行主键幂等）；`branches/*.jsonl` 不收集（防与主分支双计，仅收固定名 `conversation.jsonl`）；早期会话无 metadata 的行跳过

### Trae Agent（`trae-agent`，已实现）

- **数据位置**：官方把轨迹写到**运行时工作目录** `trajectories/trajectory_*.json`（无全局会话目录、无官方环境变量）；项目约定监控点 `~/.local/share/trae-agent/trajectories`，`TRAE_TRAJECTORY_DIR` 覆盖（测试钩子兼覆盖）
- **格式**：单个 JSON 对象全量重写（非 JSONL），token 唯一来源 `llm_interactions[]`（逐次 LLM 调用 append-only；usage 取条目 `response.usage` 四桶 snake_case `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`）
- **关键字段**：**数组水位游标**（fromLine 复用为已导入条数；条目数小于水位 = 文件被覆盖重写 → 重置 0 全量重析）；`input_semantics` **行级按 provider 判定**（anthropic → 2；openai/google/azure/doubao/openrouter/ollama 等 → 1），provider 条目级 → 轨迹根对象回退；`agent_steps` 含同量 usage 一律不采（防双计）；reasoning_tokens 为 output 子集不加速率；无 requestId（绝对路径 + 条目序号主键幂等）；model 条目级 → 根对象回退

### CodeWhale（`codewhale`，已实现）

- **数据位置**：`~/.codewhale/sessions/<sessionId>.json`；`CODEWHALE_HOME` → 其下 `sessions`；`CODEWHALE_DIR` 覆盖（测试钩子兼根覆盖）
- **格式**：每会话一个完整 JSON（临时文件原子重命名，**整文件重写非追加**）
- **关键字段**：会话级快照——`metadata.total_tokens` 是唯一 token 计数（口径不明 → `input_semantics=0`；分项缺失，增量 delta 记入 input 桶、output/cache 记 0）；**快照水位游标**（fromLine 复用为上次已统计 total；total 回退 = 文件被替换 → 全量重计；delta≤0 无记录仅推游标）；requestId = `<sessionId>:<total>`；metadata.id 缺失时游标原地等待回填；上游 MAX_SESSIONS=50 保留策略使历史天然不完整；model = metadata.model（缺失兜 `'unknown'`）、project = metadata.workspace、时间取 metadata.updated_at

### Factory Droid（`droid`，已实现）

- **数据位置**：`~/.factory/sessions/**/*.jsonl`（现行布局）+ `~/.factory/projects/**/*.jsonl`（旧布局，版本迁移过）双扫；`DROID_DIR` 覆盖数据根（测试钩子，= 数据根 `~/.factory`）
- **格式**：JSONL 事件流（`session_start` / `message` / `compaction_state` 等类型判别），usage 在 `type=="message"` 且 `message.role=="assistant"` 的 `message.usage`（Anthropic 风格四分项 camelCase `inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens`）
- **关键字段**：`input_semantics=2`（第三方解析器一致行为佐证，中等置信推测）；**同 message.id 流式多行折叠取 output 最大**（与 claude 插件同款 foldById）；`session_start.cwd` → project（状态机每轮从文件头全量扫描提取、跨批续读可恢复）；requestId = message.id；`agent-*.jsonl` 子代理文件同格式收集；`<uuid>.settings.json` 会话级累计不采（非 `.jsonl` 天然排除，防双算）

### MiniMax Code（`minimax`，已实现）

- **数据位置**：`~/.minimax/sqlite.db`（legacy，表 `token_usage`）+ `~/.minimax/v2/sqlite/runtime-state.sqlite`（runtime，表 `local_runtime_token_usage`）**双库独立统计**；`MINIMAX_DIR` / `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 覆盖（测试钩子兼覆盖）
- **格式**：SQLite（WAL，只读，250ms busy 短超时），两表列集相同（`id / session_id / turn_id / model / ts / input_tokens / output_tokens / reasoning_tokens / cache_read_tokens / cache_write_tokens / cost_usd`；插件必需列集为其中 9 列）
- **关键字段**：PRAGMA `table_info` 列探测防御（缺列空处理游标不动）；游标 = rowid 水位（两库各自独立游标，按 file_path 天然隔离）；同 `turn_id` 可多行（agent 逐步一行）各自产出不折叠；`input_semantics=2`（推测，中等置信）；reasoning_tokens 为 output 子集不加速率；不设 requestId；**双库并存可能重叠**（legacy 与 runtime 对同一活动的用量无可靠判别依据，docs 层面标注风险）

### 第三批侦察排除（NO-GO，2026-09-11）

12 候选中 3 源经联网侦察后排除，重启条件附后：

- **Cursor CLI**：`~/.cursor/chats/` 的 store.db（content-addressed blobs）与 agent-transcripts JSONL **本地均无 token 用量**（官方论坛与多个第三方逆向实现一致证实；唯一 usage 输出在 `--print --output-format stream-json` 的 stdout，不落盘）。
- **Antigravity CLI**：会话索引/transcript JSONL 无 token；token 仅存于 `conversations/<uuid>.db` 的 `gen_metadata` **未文档化 protobuf blob**（第三方逆向口径互不一致、无稳定 schema），不满足宽松解析与可验证产出标准。
- **Crush**：`.crush/crush.db` 的 sessions 表 token 列为「最后一次 run 快照覆盖」且请求失败时写入估算值，唯一可靠的累计字段是美元 cost，与项目「统一本地计价 + 实测与推断分离」口径冲突。
- **重启条件**：上游将 usage 明细化落盘（cursor / antigravity）或 token 列改为逐请求累计（crush）时重评。

## 失败判定（已实现，2026-08-27，T01 矩阵 SSOT）

> 契约 SSOT：`shared/failure.ts` 的 `isIgnoredFailureReason` / `IGNORED_FAILURE_STATUSES` / `ERROR_MESSAGE_MAX_LENGTH` 常量与 `shared/dto.ts` 的 `UsageRecord` / `RequestStatus` 类型（代码注释已于 2026-08-28 全部移除，知识库为唯一事实来源），本节为面向实现的逐插件展开；`shared/failure.ts` 的 `ERROR_MESSAGE_MAX_LENGTH=500` 与 `IGNORED_FAILURE_STATUSES=['cancelled','interrupted']` 为截断与中断忽略的唯一来源。约束：`httpStatus` / `errorMessage` 仅 `status='error'` 时有效，成功/中断为 `undefined`（存储层为 `NULL`，见 [数据模型](data-model.md) v8）；`status` 缺省视为 `'success'`。

通用规则：HTTP 4xx/5xx、isApiErrorMessage、LLM failure、`status != completed/success` 即判 `error`；`cancelled` / `interrupted`（大小写不敏感，`isIgnoredFailureReason`）属用户中断，**忽略不计 error**——插件层不产出 error 记录，collector 不放行亦不入库，不触发失败告警与 rollup `error_count`。

> 覆盖范围：下表 T01 矩阵当前覆盖**首批 8 源**（2026-09-10 第二批 14 源接入时未实现失败判定——新源解析为宽松兜底、不产出 error 记录，后续迭代再逐源补齐）。

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

补充约束（首批 8 插件统一，失败判定覆盖源）：

- **零 token 放行**：失败记录即使 `input/output/cacheRead/cacheCreation` 四项全 0 亦经 `collector.isAllZeroUsage` 放行入库（`status==='error'` 时 `isAllZeroUsage` 返回 `false`），成功记录仍保持全零拦截（见 [同步与去重](sync-mechanism.md) 与 [数据流](data-flow.md)）。
- **截断位置**：插件层与 `storage.toUsageRecordRow` 双层截断 500（`ERROR_MESSAGE_MAX_LENGTH`），表格预览另截断 64，详情抽屉完整展示；`collector.truncateErrorMessage` 入库前再收敛一次。
- **性能**：首批 8 插件失败分支均为追加的 `if` 字符串/对象字段宽松比较 + 单次 `slice(0,500)`，无正则/全表扫描，成功路径仅多一次相等比较，热点路径（JSONL 解析 / SQLite 扫描 / zstd 解压）零回退。

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