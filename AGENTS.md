# AGENTS.md

## 仓库状态

- 本项目仍处于**规划阶段**：无源码、`package.json`、构建配置或 CI。尚未初始化脚手架。
- 现有资产：`AGENTS.md`、`docs/`（项目知识库 = 唯一设计依据）。
- **`docs/` 知识库是唯一的设计依据**：所有架构决策、数据模型、里程碑都在其中。动手写代码前先读 `docs/index.md`，避免与既定设计冲突。

## 既定技术决策（见 docs/ 知识库，勿擅自更改）

- 桌面框架：**Electron**；语言：**TypeScript**；包管理：**pnpm**（workspace 单仓）。
- 构建：electron-vite；渲染层：**React + Vite** + Tailwind + TanStack Query + Recharts。
- 数据存储：**better-sqlite3**（仅主进程使用，同步 API）。
- 文件监听：chokidar + 定时兜底扫描（默认 5 分钟）。
- **采集方式：仅"扫描各 CLI 本地会话日志"，不做代理拦截**（第一阶段）。
- **监控架构：一切皆插件（自研）**。每个监控对象（CLI）是一个独立插件，经插件注册表动态装载/卸载；宿主提供服务容器 `ctx`、依赖注入、生命周期与事件总线。设计借鉴了通用插件框架的工作机制，**为自研实现，不依赖第三方插件框架，亦不移植任何既有项目代码**。

## 架构要点（不显而易见）

- 数据流：`CLI 会话文件(JSONL) → 插件增量解析(行游标) → 去重 → 费用计算 → usage_records 明细 → usage_daily_rollups 日聚合 → 前端查询`。
- 主进程承担全部数据逻辑（插件宿主 / 服务 / SQLite / 查询服务）；渲染进程只通过 preload `contextBridge` 的白名单 API 通信，禁止直接暴露 Node 能力。
- 插件体系核心：`MonitorPlugin` 统一接口（`id / name / version / deps / detect / listFiles / parseFile / dispose`）；插件经 `ctx` 访问服务（storage / pricing / events / scheduler / watcher）。**新增监控对象 = 新增一个插件目录，零改动宿主**。
- 增量同步游标、去重账本、Token 语义归一化、模型 ID 归一化、定价表这 5 个机制是核心设计，见 docs/concepts/data-flow.md / sync-mechanism.md / pricing.md。

## 风险与注意

- **第一阶段范围 = 5 个内置监控插件**（claude / codex / opencode / gemini / grok）；后续可随时新增插件扩展监控对象。
- 各 CLI 日志格式会随版本漂移：插件必须**宽松解析 + 错误兜底**（单文件解析失败不得阻塞整体同步），并过滤正在写入的半行与临时文件（如 `*.tmp`）。
- 插件宿主需保证**可逆生命周期**：任何注册（监听/服务/事件）都要在卸载时清理，避免插件热切换产生泄漏。

## 项目知识库

- 位置：`docs/`。`index.md`（目录）与 `log.md`（按天摘要，仅留 7 天）为保留文件，不含 frontmatter。
- 概念页面：`docs/concepts/*.md`，每个概念一页，必须含 YAML frontmatter（`type` 必填，同类概念用一致值；`timestamp` 用真实系统时间）。
- 维护日志：`docs/changelog/YYYY-MM-DD-HH.md` 按小时合并，每次更新后追加；更新页面须同步刷新其 `timestamp`。
- 内容约束：基于实际实现，禁止推测；无法核实处标 `> [!todo] 待补充`；当前均为「规划中」状态。
- 若后续落地代码，新增/修改概念时增量更新受影响页面，删除过时描述，保持与 AGENTS.md / docs/ 知识库一致。
