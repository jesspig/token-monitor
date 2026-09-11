---
type: plugin-implementation
title: 监控插件
description: MonitorPlugin 统一接口与 31 个内置监控插件的当前数据位置、格式、游标、语义身份、快照修正和兼容边界。
tags: [plugin, monitor, cli, sqlite, jsonl, cursor, dedup, snapshot]
resource: src/main/plugins/
timestamp: 2026-09-11T12:03:38+08:00
---

# 监控插件

> [!note] 当前状态
> 当前宿主装配 **31 个内置插件**。2026-09-11 完成兼容性加固：DSH、Kilo Code、Kiro 更新到已验证的当前存储；Copilot CLI、gptme、Trae Agent 修复恢复或发现问题；Command Code、CodeWhale、OpenCode 系、Cline/Roo 更新增量和目录规则；Claude、Kiro current、Droid 接入可替换成功快照；MiniMax 接入跨库语义身份。验证基线：typecheck 两段通过、vitest **54 个测试文件 / 1166 个用例**通过、`pnpm build` 通过。

## `MonitorPlugin` 契约

`shared/plugin.ts` 定义统一接口：

- `id/name/version/deps`：插件身份和依赖。
- `detect(ctx)`：探测可用性并返回可解释原因。
- `listFiles(ctx)`：列出只读输入及 mtime。
- `parseFile(ctx, path, fromLine)`：从持久化游标继续解析，返回 `records/nextLine/eof/nextByteOffset`。
- `dispose(ctx)`：清理缓存、监听和其他生命周期资源。

插件只经 `PluginContext` 使用宿主服务。单文件失败由采集器隔离，不阻塞同插件其他文件；临时文件、点前缀文件、`.tmp`、`.swp` 和 `~` 后缀按各源规则过滤。

## 当前插件清单

| 插件 | 当前数据位置与格式 | 增量、身份与关键边界 |
|---|---|---|
| Claude Code (`claude`) | `~/.claude/projects/**/*.jsonl` | assistant usage 使用 `message.id`；单轮与跨轮均按累计 `outputTokens` 选择最佳快照。成功且有 ID 的记录标记为可替换快照，较小旧快照不倒退；错误和无 ID 记录保持不可变。 |
| Codex (`codex`) | Codex rollout JSONL | 读取 `event_msg.payload.info.last_token_usage`；按行增量，稳定 requestId 继续使用线程/事件字段组合。 |
| OpenCode (`opencode`) | `opencode.db`、`opencode-prod.db`，兼容旧 `storage/message` JSON | SQLite 使用数据库指纹 + rowid 编码水位；`message.id` 为 requestId；旧时间戳游标、数据库身份变化或 rowid 回退会从头安全重读。 |
| Gemini CLI (`gemini`) | legacy 单 JSON 与 append-only JSONL | 双格式兼容，按消息 ID 去重；尾部半行不推进。 |
| Grok (`grok`) | `unified.jsonl` + `summary.json` | usage 行依赖会话到模型映射；每轮重建或读取映射，按行增量。 |
| Pi (`pi`) | 会话 JSONL 树 | assistant message 四桶互斥，requestId 使用条目 ID。 |
| Zcode (`zcode`) | `cli/db/db.sqlite` | SQLite rowid 水位并感知 WAL；requestId 使用 `model_usage.id`。 |
| DSH (`dsh`) | `~/.dsh/sessions` 下 legacy `session.jsonl[.zstd]` 与 `session.v1/v2.jsonl[.zstd]` | zstd 使用 `byte_offset` 帧边界增量；重启时只读重放已消费前缀恢复 session/model 状态，不重产历史。未来版本、未知压缩、`.dsh` 工件和 SQLite 后端显式报告不兼容，不猜测解析。 |
| WorkBuddy (`workbuddy`) | `~/.workbuddy/projects/**/*.jsonl` | Tencent Buddy 共享解析器；稳定请求 ID 存在时参与语义去重。 |
| CodeBuddy (`codebuddy`) | `~/.codebuddy/projects/**/*.jsonl` | 与 WorkBuddy 共用解析内核；当前只覆盖已实现的 CLI 根。 |
| Cline (`cline`) | VS Code Stable、VS Code Insiders、VSCodium、Cursor 的 `globalStorage/saoudrizwan.claude-dev/tasks/*/ui_messages.json` | `CLINE_DIR` 可显式覆盖；显式 requestId → 文本内 requestId → `ts` → 数组索引降级。跨编辑器同任务选择 mtime 最新副本。**Cline CLI/SDK-managed 会话未接入**，不能复用经典扩展快照解析器。 |
| Roo Code (`roo-code`) | 上述四类编辑器的 `globalStorage/rooveterinaryinc.roo-cline/tasks/*/ui_messages.json` | `ROO_CODE_DIR` 可显式覆盖；复用 Cline 稳定身份和多根去重规则。未验证的 Roo CLI 形态不接入。 |
| Kilo Code (`kilo-code`) | 当前 `kilo.db`；兼容旧扩展 `globalStorage/kilocode.kilo-code/tasks/*/ui_messages.json` | 当前库使用只读 SQLite、WAL mtime、rowid 水位和 `message.id`；`KILO_DATA_HOME` 支持当前数据根，`KILO_CODE_DIR` 保留旧扩展覆盖。当前库兼容时只枚举该库，避免与迁移后的旧扩展双计；当前库存在但不兼容时仍保留为显式失败输入，旧扩展文件可由单文件隔离继续解析。当前库 input/cache 包含关系未证实，`inputSemantics=0`；旧扩展保持已验证语义。 |
| Qwen Code (`qwen`) | `$QWEN_RUNTIME_DIR` / `$QWEN_HOME` / `~/.qwen/usage/token-usage-*.jsonl` | JSONL 行增量，requestId 使用行 ID；input 含缓存总量。 |
| Qoder (`qoder`) | `SharedClientCache/cache/db/local.db` 等候选 | SQLite `chat_message` rowid 水位；缓存包含关系未知。 |
| Qoder CN (`qoder-cn`) | Qoder CN 多候选 `local.db` | 复用 Qoder 解析内核；缓存包含关系未知。 |
| Kimi Code (`kimi`) | `~/.kimi-code/sessions/**/wire.jsonl` | 仅统计 `usage.record` 且 `usageScope=turn`；无稳定 ID 时依赖文件路径和行号。 |
| Zed (`zed`) | `threads/threads.db` | 读取明文 JSON 或 zstd thread 数据；rowid + updated_at 双水位，按 thread/usage 键构造 requestId。 |
| Kiro CLI (`kiro`) | 当前 `data.sqlite3` 的 `conversations_v2`；兼容旧 `~/.kiro/sessions/cli/*.jsonl` + sidecar JSON | 当前库每次 mtime 变化重读会话行，并以稳定 session/turn/message 身份产生**可替换成功快照**；旧 sidecar 保持不可替换。只接受显式 `input_token_count/output_token_count`，没有显式 Token 时标记不兼容并**拒绝估算**；缓存桶为 0，`inputSemantics=0`。 |
| Reasonix (`reasonix`) | `stats/YYYY-MM-DD.jsonl` | 按行读取已实现字段；无稳定 ID 时依赖文件路径和行号。 |
| Command Code (`command-code`) | `~/.commandcode/projects/**/*.jsonl` | 每轮只读扫描文件前缀恢复 session/project/model/parentMap/活动尾节点；前缀不产出，只有游标窗口内活动分支 usage 进入结果。 |
| Copilot Chat (`copilot-chat`) | VS Code Stable 的全局/工作区 chatSessions JSONL | 顺序合并 patch 重建请求终值；当前只覆盖已实现目录。 |
| DevEco Code (`dev-eco`) | `deveco.db`、`deveco-beta.db`、`deveco-prod.db` | 复用 OpenCode-like 内核：数据库指纹 + rowid 编码水位、`message.id` requestId、WAL mtime。 |
| MiMo Code (`mimo`) | `mimocode.db`、`mimocode-beta.db`、`mimocode-prod.db`，含默认根与 `$MIMOCODE_HOME/data` | 复用 OpenCode-like 内核，游标和重建规则同 DevEco/OpenCode。 |
| Goose (`goose`) | XDG/`GOOSE_PATH_ROOT` 下 usage 数据 | 读取已实现的 usage ledger；无稳定 ID 时保守依赖本地行身份。 |
| Copilot CLI (`copilot-cli`) | Copilot CLI 会话 JSONL shutdown 累计指标 | 从游标前缀重建每模型、每 Token 桶历史高水位；缓存仅优化性能。累计回退不产生负数，只有超过历史高水位部分计入。 |
| gptme (`gptme`) | 普通会话及递归 `branches/**/conversation.jsonl` | 顶层 `id` / `message_id` / `metadata.message_id` 作为跨文件身份；fork/branch 复制历史保留同 ID 时由语义去重折叠，独占后缀正常计入。缺 ID 时不使用内容哈希猜测关系。 |
| Trae Agent (`trae-agent`) | 设置页显式配置多个 trajectory 根；兼容单根 `TRAE_TRAJECTORY_DIR` 和旧默认候选 | 多根规范化、物理路径去重并动态刷新 watcher；不扫描整个用户目录或磁盘。trajectory JSON 仍按 provider 决定 input semantics。 |
| CodeWhale (`codewhale`) | `~/.codewhale/sessions/*.json` 的 `metadata.total_tokens` | 采用保守会话快照：首次只建基线、不回填历史；上升只计差值；下降/compaction 只重置；fork 新文件首次也只建基线。全部增量记入 input，`inputSemantics=0`，不伪造 output/cache，无法还原快照间模型切换。 |
| Factory Droid (`droid`) | `sessions/`、`projects/` 下 JSONL，并发现 `*.settings.json` | JSONL 成功且有 `message.id` 的 usage 为可替换快照，跨轮以前缀最佳值收敛；双布局相同 ID 不双计。settings 文件只做发现、mtime 与 JSON/schema 验证，**不计算 Token、不反推费用**。 |
| MiniMax Code (`minimax`) | legacy `sqlite.db/token_usage` 与 runtime `runtime-state.sqlite/local_runtime_token_usage` | row ID 负责单库水位和 source line；仅在 `session_id`、`turn_id`、记录 `id` 均有效时构造 `minimax:[session,turn,id]` 语义 ID，使双库迁移重叠记录收敛；缺身份时保守退回文件/行幂等。 |

## OpenCode-like 编码水位

`src/main/plugins/_lib/opencode-shared.ts` 由 OpenCode、DevEco、MiMo 共用：

1. 只读打开 SQLite，探测 `message/session` 必需表列。
2. 游标编码数据库指纹与最后处理 rowid，不再使用单一 `time_created` 水位。
3. 旧数字时间戳游标自动视为旧格式并从头重读；稳定 `message.id` 负责语义去重。
4. schema、首条消息身份变化，或游标 rowid 大于当前最大 rowid时，从头自愈。
5. 合法但无 usage 的行仍推进 rowid；损坏 JSON、缺表或缺列显式失败且不推进。
6. 保留相同数据库身份和 rowid、仅原位更新旧行的情况不会重新产出；当前实现不猜测上游快照更新语义。

## 可替换成功快照

当前仅逐源启用：

- Claude：成功且有 `message.id`。
- Kiro current SQLite：具有稳定 turn 身份的当前库记录；旧 sidecar 不启用。
- Droid：成功且有 `message.id` 的 JSONL usage；settings 不产出记录。

标记为 `isReplaceableSnapshot` 的新旧记录必须同源、同 requestId、均为成功且均可替换，存储层才允许更新。错误记录、无稳定 ID 的记录和其他插件继续使用不可变事件语义。

## 计费语义

`inputSemantics`：0=输入与缓存关系未知；1=input 含缓存总量，计费前扣减缓存；2=input 已是纯新输入。

- 固定为 1：Codex、Gemini、Grok、Zcode、WorkBuddy、CodeBuddy、Qwen、Reasonix、Goose、Copilot CLI。
- 固定为 2：Claude、OpenCode、Pi、DSH、Cline、Roo Code、Kimi、Zed、Command Code、Copilot Chat、DevEco、MiMo、gptme、Droid、MiniMax。
- 固定为 0：Qoder、Qoder CN、Kiro、CodeWhale。
- Kilo Code：当前 `kilo.db` 为 0，旧扩展记录为 2。
- Trae Agent：按行 provider 判定；Anthropic 系为 2，已验证的 OpenAI 等 provider 分支为 1。

## 容错边界

- 尾部半行、半帧不推进到不安全位置；非尾部损坏行是否跳过由各插件已验证行为决定。
- 外部数据库始终只读；数据库/WAL mtime 用于变更检测。
- schema 不兼容、损坏数据库和关键字段缺失应与“没有新增记录”区分。
- 无稳定 requestId 时不使用正文、Token 或时间近似猜测跨文件身份。
- 无法验证的 Token 字段不做估算：Kiro 拒绝字符数/credits/context 百分比换算；Droid settings 不作为 Token 来源；CodeWhale 不拆分未知四桶。

## 关联页面

- [插件体系](plugin-architecture.md)
- [总体架构](architecture.md)
- [同步与去重](sync-mechanism.md)
- [数据模型](data-model.md)
- [返回目录](../index.md)
