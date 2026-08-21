---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 5 个内置监控插件（claude/codex/opencode/gemini/grok）实现清单。
tags: [plugin, monitor, cli, claude, codex, opencode, gemini, grok]
resource: src/main/plugins/
timestamp: 2026-08-21T23:41:51+08:00
---

# 监控插件

> [!note] 当前状态
> **第一阶段 5 个内置插件已实现**（2026-08-20）：`src/main/plugins/{claude,codex,opencode,gemini,grok}.ts`，各有单测覆盖；解析格式均经联网核实。本页清单已按实际实现核对（2026-08-21）。

## `MonitorPlugin` 接口（实现于 shared/plugin.ts）

```ts
interface MonitorPlugin {
  id: AppType;               // 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok'
  name: string;              // 显示名
  version: string;
  deps?: ServiceKey[];       // 依赖服务，宿主按依赖解析装载顺序
  detect(ctx): Promise<Detection>;          // CLI 是否安装、会话目录是否存在
  listFiles(ctx): Promise<FileEntry[]>;      // { path, mtime }
  parseFile(ctx, path, fromLine): Promise<ParsedResult>; // 增量解析，返回新记录+新偏移
  dispose?(ctx): void;       // 卸载时清理监听/游标
}
```

`ParsedResult` 含 `records`、`nextLine`（游标推进）、`eof`（是否到文件尾）。5 个内置插件的 `deps` 均为 `['storage','pricing','events']`。

## 内置插件清单（第一阶段 5 个，按实际实现）

| 插件 id | 数据根（可环境变量覆盖） | 扫描范围 | 解析源与关键字段 |
|---|---|---|---|
| claude | `~/.claude/projects` | 各编码项目目录直接子层 `*.jsonl` + 会话子目录内 `subagents/`、`workflows/` 子树递归 | 行 `type=="assistant"` 且含 `message.usage`：`input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`；`input_semantics=2`（纯新输入） |
| codex | `~/.codex/sessions` | 全子树递归 `*.jsonl`（日期分区 `YYYY/MM/DD/` + `archived_sessions/`） | rollout JSONL 状态机解析：模型取 `turn_context.payload.model`，用量取 `event_msg(token_count).payload.info.last_token_usage`，cwd/sessionId 取 `session_meta`；`input_semantics=1` |
| opencode | `~/.local/share/opencode`（`$OPENCODE_HOME`） | 双源二选一：新版 `opencode.db`(SQLite) 单条目；否则旧版 `storage/message/*.json` + `storage/session/**/*.json` | 新版读 `message` 表（join `session.directory`），游标 = `time_created` 水位，data 列 `role=="assistant"` 的 `modelID / tokens{input,output,cache.read,cache.write}`；旧版每文件一条消息 JSON 同构解析；`input_semantics=1` |
| gemini | `~/.gemini/tmp` | `<project_hash>/chats/session-*.json`（单个 JSON 对象，非 JSONL） | `messages[]` 中 `type=="gemini"` 且含 `model/tokens` 的消息；tokens 键名多组宽松兼容（`input/input_tokens/inputTokens` 等）；游标 = 消息序号；`input_semantics=1` |
| grok | `~/.grok`（`GROK_HOME`） | `logs/unified.jsonl` + `sessions/**/summary.json` | unified.jsonl 行 `msg=="shell.turn.inference_done"`：`ctx.prompt_tokens / completion_tokens / cached_prompt_tokens`（prompt 含缓存读，`input_semantics=1`）；模型来自 summary.json `current_model_id` 建立的 sessionId→模型映射 |

各插件共同行为：

- 文件过滤仅收 `*.jsonl` / `*.json` 候选（gemini 仅 `session-*`，grok 仅 `unified.jsonl` 与 `summary.json`），排除临时/隐藏文件（`.tmp`、`.swp`、`.`前缀、`~`后缀）。
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