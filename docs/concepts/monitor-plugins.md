---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 8 个内置监控插件（claude/codex/opencode/gemini/grok/pi/zcode/dsh）实现清单。
tags: [plugin, monitor, cli, claude, codex, opencode, gemini, grok, pi, zcode, dsh]
resource: src/main/plugins/
timestamp: 2026-08-24T02:22:00+08:00
---

# 监控插件

> [!note] 当前状态
> **第一阶段 5 个内置插件已实现**（2026-08-20）：`src/main/plugins/{claude,codex,opencode,gemini,grok}.ts`，各有单测覆盖；解析格式均经联网核实。本页清单已按实际实现核对（2026-08-21）；CLI 版本探测于 2026-08-22 接入；语义请求 ID（requestId）与 opencode 语义标注修正/WAL 感知于 2026-08-23 接入；**claude 流式分片折叠与 gemini 新版 JSONL 双格式兼容于 2026-08-23 落地**（五源日志格式已按各 CLI 最新版联网复核）；**pi / zcode / dsh 三插件于 2026-08-23 接入，内置监控对象扩展至 8 个**（格式均经上游源码/社区实测核实）。

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
| grok | `~/.grok`（`GROK_HOME`） | `logs/unified.jsonl` + `sessions/**/summary.json` | unified.jsonl 行 `msg=="shell.turn.inference_done"`：`ctx.prompt_tokens / completion_tokens / cached_prompt_tokens`（prompt 含缓存读，无 write 桶，`input_semantics=1`）；requestId = `<sid>:<loop_index>` 组合键（会话内推理循环序号）；模型来自 summary.json `current_model_id` 建立的 sessionId→模型映射，**listFiles 每轮无条件重建映射**（新增 summary.json 当轮即生效） |
| pi | `~/.pi/agent/sessions`（`$PI_CODING_AGENT_DIR` 覆盖根） | sessions 子树递归 `*.jsonl`（按工作目录编码层组织） | JSONL 树结构：首行 header `{type:'session', id, cwd}` 建立会话状态；`type==='message'` 且 `role==='assistant'` 且含 usage 的条目产出——usage 四桶 input/output/cacheRead/cacheWrite **互不重叠**，`input_semantics=2`；上游自带 usage.cost 不采用（统一本地计价）；requestId = 条目 `id`（fork 提取分支跨文件收敛）；compaction/model_change 等条目天然跳过 |
| zcode | `~/.zcode`（`$ZCODE_STORAGE_DIR` 重定位整个根） | 单数据源 `cli/db/db.sqlite`（SQLite 只读） | schema 核实自 CLI db v0.14.8（codeburn 实测）：`model_usage LEFT JOIN session` 取 directory；**input_tokens 已含缓存读写 → `input_semantics=1`**（直接计费约 8 倍高估）；reasoning_tokens 独立列不折入 output；时间戳 epoch 毫秒，createdAt = completed_at ?? started_at；游标 = **rowid 水位**（line=rowid 单调唯一）；WAL mtime max 感知；requestId = `model_usage.id`（每请求唯一） |
| dsh | `~/.dsh/sessions`（`$DSH_HOME` 覆盖 home） | 子树递归固定名工件 `session.jsonl.zstd` / `session.jsonl`（SQLite 后端 `.db` 暂不支持，detect reason 提示） | `.jsonl.zstd` 经 **fzstd（纯 JS zstd 解压）** 整文件解压后逐行解析 event-sourced envelope `{type, seq, time, data}`（SESSION_FORMAT_VERSION=0 pre-release，破坏性变更时宽松解析+联网复核维护）；`assistant/message` 且 data.usage 产出——TokenUsage disjoint 约定（inputTokens 不含缓存），`input_semantics=2`；reasoningTokens 为 output 子集不加速率；**模型两级来源：message.model 缺失（120 会话/6084 条实测均无）时取此前最近 request/header 的 `data.header.config.model` 状态机**；requestId = `<sessionId>:<seq>`（fork seed 继承跨文件稳定）。已用真实数据端到端验证：6084/6084 全部产出、0 跳过 |

各插件共同行为：

- 文件过滤仅收 `*.jsonl` / `*.json` 候选（gemini 仅 `session-*`，grok 仅 `unified.jsonl` 与 `summary.json`，dsh 仅固定名 `session.jsonl[.zstd]`），排除临时/隐藏文件（`.tmp`、`.swp`、`.`前缀、`~`后缀）。
- requestId 宽松采用：string 且 trim 非空才写入 `source.requestId`；任一成分缺失时不设置（退回 `(file_path, line)` 主键去重），规则见 [同步与去重](sync-mechanism.md)。
- opencode 新版 db 源的「行号」为 `time_created` 水位派生的单调序号，跨轮去重唯一。
- 时间戳缺失/不可解析时兜底 `Date.now()`。

## 容错要求

- 文件被 CLI 写入中读到半行 → 丢弃末尾不完整行，游标停在最后完整行。
- 单文件解析失败不阻塞整体同步，记录错误并跳过。
- 对未知字段宽松解析（lenient parse），日志格式随版本演进不崩溃。

## 关联页面

- [插件体系](plugin-architecture.md) — 插件如何被宿主装载。
- [总体架构](architecture.md) — plugins 模块归属。
- [同步与去重](sync-mechanism.md) — 游标如何与 parseFile 协同。
- [返回目录](../index.md)