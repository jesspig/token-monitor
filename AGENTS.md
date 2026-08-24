# AGENTS.md

## 项目定位与设计依据

- Electron + TypeScript 桌面工具：监控多个 AI 编程 CLI 的 Token 用量与费用；采集方式为扫描各 CLI 本地会话日志，**不做代理拦截**。
- **改代码前先读 `docs/index.md`**：`docs/` 知识库是唯一设计依据，全部概念页已与实现对齐（2026-08-21 审计 + 2026-08-23 第五轮迭代同步）。既定技术栈（Electron / electron-vite / React + Tailwind + TanStack Query + Recharts / better-sqlite3 / chokidar）勿擅自更改。
- 第一阶段已交付：插件宿主 + 5 个内置监控插件（claude / codex / opencode / gemini / grok）；2026-08-23 第五轮迭代（对标 cc-switch）完成计费语义修复、语义去重接入、定价匹配增强，并完成各 CLI 最新版日志格式联网复核与兼容（claude 按 message.id 折叠流式分片；gemini 双格式兼容新版 append-only JSONL；codex output 已含 reasoning 勿加速率）；同日接入 pi / zcode / dsh 三个监控插件（内置 8 个；dsh 引入纯 JS 解压依赖 fzstd，禁止 napi 系 zstd 包以防 ABI 坑）；2026-08-24 完成主进程防阻塞性能优化（采集 mtime 短路 + watcher 定向同步 syncPlugin + 启动错峰 + 定价写入单事务批量化 + 渲染端轮询默认 30s）与 dsh 模型三级来源（source.model 优先）+ 会话头状态缓存。当前 typecheck / 361 单测 / 构建全部通过。

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发模式（electron-vite dev，热更新） |
| `pnpm typecheck` | 类型检查（tsconfig.node.json + tsconfig.web.json 两段串行） |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run` | 全部单测（24 文件 / 286 用例，经 Electron 内置 Node v20.18.3 运行）。**package.json 没有 test 脚本；且 better-sqlite3 已重编为 Electron ABI，`pnpm exec vitest run` 会报 NODE_MODULE_VERSION 错，只能这样跑** |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run src/main/services/storage.test.ts` | 单文件测试 |
| `pnpm build` | 构建到 `out/`（main/preload/renderer 三段） |
| `pnpm dist` / `pnpm dist:dir` | electron-builder 打包（安装包 / 解包目录），产物在 `release/` |

- 无 lint / format 配置；验证闭环 = typecheck + vitest。

### 环境坑（本机沙箱）

- pnpm 11 跑任何脚本前会自动执行依赖校验安装；非 TTY 终端下会报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。**先设 `$env:CI='true'` 再跑 pnpm 命令**。
- 沙箱限制写用户目录：`pnpm install` 需 `--no-frozen-lockfile --cache-dir ./.pnpm-cache --store-dir ./.pnpm-store`；打包时设 `ELECTRON_CACHE`/`electron_config_cache` 指向 `.electron-cache`、`npm_config_cache` 指向 `.npm-cache`。这些缓存目录已在 `.gitignore`。
- better-sqlite3 有 ABI 双运行时冲突：安装时按系统 Node v24 编译（ABI 137），Electron 33.4.11 需要 ABI 130，`pnpm dev` 会报 `NODE_MODULE_VERSION 137 vs 130` 崩溃。已用 `pnpm dlx @electron/rebuild -f -w better-sqlite3 -v 33.4.11` 重编为 Electron ABI（dev 已验证正常）；副作用是系统 Node 下 vitest 加载不了该二进制，**单测必须经 Electron 内置 Node 跑**（见上表命令）。**禁止**再用 `pnpm exec vitest run` 跑主进程相关测试（ABI 报错），也**禁止**再对 better-sqlite3 执行面向系统 Node 的 rebuild（会反过来弄坏 dev）；electron-builder 打包不受影响（其自带 install-app-deps 重编逻辑）。

## 架构速览（不显而易见）

- 数据流：`CLI 会话文件 → 插件增量解析(行游标) → 去重 → 费用计算 → usage_records 明细 → usage_daily_rollups 日聚合 → 前端查询`。
- 进程边界：主进程承担全部数据逻辑；渲染进程只经 preload `contextBridge` 白名单 API 通信（契约 = `shared/ipc.ts` 的 RendererApi，17 通道），禁止直接暴露 Node 能力。
- 插件体系为自研框架（`src/main/core/`：registry/context/lifecycle/event-bus）：**新增监控对象 = 新增 `plugins/<id>.ts` 实现 `MonitorPlugin`，并在 `host.ts` 的 `BUILTIN_PLUGINS` 登记一行**。插件经服务容器 `ctx`（storage/pricing/events/scheduler/watcher）访问能力、用 `deps` 声明依赖，不直接 import 宿主实现。
- 去重现状：双层——记录 id = `data_source:file_path:line` + INSERT OR IGNORE（主键幂等）；五插件产出稳定 `source.requestId`，入库事务内按 `(data_source, request_id)` 查写 `dedup_ledger` 做 fork/rewrite 语义去重（2026-08-23 接入，命中不入明细/rollup/事件）。
- 计费语义：`input_semantics` 三态（0=未知 / 1=含缓存总量需扣减 / 2=纯新输入）；codex/gemini/grok=1、claude/opencode=2；`calcCost` 对 semantics=1 先扣缓存再乘价；存量高估费用由 `pricing.recalcCachedInputCosts` 启动重算（v4 迁移只修 opencode 标注）。
- 关键默认值：兜底同步间隔 5 分钟（设置可调）；明细保留 90 天、日聚合永不清理、**保留清理前先尽力零成本回填**；事件 `usage-updated` 200ms 防抖、watcher 500ms 防抖；seed 定价 99 个模型（USD）。
- 定价为只读 + models.dev 每 5 分钟自动同步：手动更新/删除定价的 IPC 通道已删除，定价写入唯一入口是 models.dev 同步链路（`host.syncModelsDevPricing` 内部先 `invalidateCache` 再回填），无需手动调缓存失效。
- 各 CLI 数据源差异大（opencode/zcode 为 SQLite 只读源、gemini 双格式 JSONL+legacy JSON、grok 靠 summary.json 建 sessionId→模型映射、claude 同轮多行需按 message.id 折叠、dsh 默认 zstd 压缩需 fzstd 解压），改插件前先读 `docs/concepts/monitor-plugins.md` 的实际清单。

## 行为约束

- 监控插件必须**宽松解析 + 错误兜底**：单文件解析失败不得阻塞整体同步；过滤正在写入的半行与临时文件（`.tmp` / `.swp` / 点前缀 / `~` 后缀）。
- 插件宿主保证**可逆生命周期**：任何注册（监听/服务/事件）卸载时必须清理，避免插件热切换泄漏。
- better-sqlite3 仅主进程使用（内部同步 API，对外 Promise 签名）。

## docs/ 知识库维护规则

- 概念页 `docs/concepts/*.md` 必须含 YAML frontmatter（`type` 必填且同类概念一致值；对应具体源码资产加 `resource`；`timestamp` 用真实系统时间）；内容基于实际实现，无法核实处标 `> [!todo] 待补充`。
- `index.md` / `log.md` 为保留文件不含 frontmatter；`log.md` 仅留最近 7 天。
- 维护日志 `docs/changelog/YYYY-MM-DD-HH.md` 按小时合并追加；更新页面须同步刷新其 `timestamp`，并增量修订受影响概念页、删除过时描述。
