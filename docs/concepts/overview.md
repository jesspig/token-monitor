---
type: project-overview
title: Token Monitor 项目总览
description: 插件化架构的跨 CLI 用量监控桌面工具，第一阶段内置 8 个监控插件。
tags: [token-monitor, overview, electron, ai-coding-cli, plugin]
timestamp: 2026-08-28T02:27:00+08:00
---

# 项目总览

> [!note] 当前状态
> **第一阶段已实现**（2026-08-20）：插件化监控宿主 + 5 个内置监控插件端到端落地于 `src/`。**2026-08-22 第二轮迭代**：聚合查询镜像优化、保留清理接线、实时刷新、定价表 v2 + models.dev 同步、预算告警等；**第三轮迭代**：全零 token 记录入库拦截 + v3 存量清洗迁移、models.dev 定价全自动同步（定价页/IPC 只读化收窄至 17 方法）、CLI 版本探测、渲染端轮询与固定侧边栏布局；**第四轮迭代**：时间范围扩为五档（today/24h/7d/14d/30d，today 与 24h 走小时聚合）、统计页「按模型」视图移除应用列、统计刷新与价格同步间隔改为设置可配（详见 [index](../index.md)）。后续迭代已扩展至 8 个内置监控插件、统计查询卸载到只读 worker 线程、系统托盘后台常驻（见 [总体架构](architecture.md) / [数据流](data-flow.md)）。当前 typecheck / 463 项单测（2 项历史遗留失败，位于 usageQuery.test.ts 的 getHourlyTrends，与注释移除无关）通过。本页描述与实现一致。

## 定位

独立的桌面应用，监控本机多个 AI 编程 CLI 的 **Token 用量与费用**，无需配置代理。采集方式为扫描各 CLI 本地会话日志。

**架构特色：一切皆插件**。每个监控对象（CLI）是一个独立插件，通过插件注册表动态装载/卸载，新增监控对象无需改动宿主（见 [插件体系](plugin-architecture.md)）。

## 阶段性范围

- **第一阶段（8 个内置监控插件）**：Claude Code / Codex / OpenCode / Gemini CLI / Grok Build / Pi / ZCode / DSH。
- **后续阶段**：扩展 OpenClaw / Hermes / 其它 CLI / 代理拦截 / 云账单等。

> [!note] 截至 2026-08-28
> 已交付 8 个内置监控插件、统计查询卸载到只读 worker 线程、系统托盘后台常驻；全部代码注释已于本日移除，`docs/` 为唯一事实来源（代码注释已于 2026-08-28 全部移除，知识库为唯一事实来源）。

> [!todo] 待补充
> 后续阶段的监控类型细节尚未展开设计。

## 技术栈（既定决策）

| 层 | 选型 |
|---|---|
| 桌面框架 | Electron |
| 语言 | TypeScript（主进程 + 渲染进程 + preload 共享类型） |
| 包管理 | pnpm（workspace 单仓） |
| 构建 | electron-vite |
| 渲染框架 | React + Vite |
| 样式 | Tailwind CSS |
| 数据请求/状态 | TanStack Query |
| 图表 | Recharts |
| 数据存储 | better-sqlite3（主进程，同步 API） |
| 文件监听 | chokidar + 定时兜底扫描 |
| 插件框架 | 自研（注册表 + 服务容器 + 生命周期 + 事件总线） |

## 关联页面

- [总体架构](architecture.md) — 进程与模块分层。
- [插件体系](plugin-architecture.md) — 一切皆插件。
- [里程碑与风险](roadmap.md) — 实施路线图。
- [返回目录](../index.md)
