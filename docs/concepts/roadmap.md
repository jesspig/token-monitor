---
type: roadmap
title: 里程碑与风险
description: M1–M7 实施路线图与待研究点；插件框架先行，再铺开内置监控插件。
tags: [roadmap, milestone, risk, planning, plugin]
timestamp: 2026-08-19T20:25:00+08:00
---

# 里程碑与风险

> [!note] 当前状态
> 规划阶段，里程碑尚未启动（当前位于 M1 之前）。

## 实施路线图

| 里程碑 | 内容 | 交付物 |
|---|---|---|
| **M1 脚手架** | Electron + electron-vite + React + TS + Tailwind + pnpm workspace + better-sqlite3 打通 | 可启动空壳应用 + IPC 示例 |
| **M2 插件框架内核 + 数据层** | `core/`（registry/context/lifecycle/event-bus）+ schema/迁移/DAO/定价 seed/游标/去重表 | 插件宿主与 SQLite 模块，可单测 |
| **M3 首个监控插件端到端** | claude 插件 + 服务 + 费用计算 + Dashboard 最小闭环（真实数据） | 第一个可用监控对象 |
| **M4 其余内置插件** | codex / opencode / gemini / grok | 5 个内置插件全部可同步 |
| **M5 可视化完善** | 趋势图、日志表、统计、筛选、插件启停管理、实时刷新 | 完整 Dashboard |
| **M6 设置与健壮性** | 同步间隔、保留策略、错误上报、跨平台路径、打包 | 可发布 Beta |
| **M7（后续）** | 扩展更多监控插件（OpenClaw / Hermes 等）/ 代理拦截 / 云账单 / 导出 | 迭代版本 |

**建议顺序**：先做 M2→M3 打通插件框架 + 一个监控插件的端到端闭环，验证插件化架构后再批量铺开其余插件。

## 待研究点 / 风险

1. **多平台路径**：Windows / macOS / Linux 的 home 目录差异（`~`、`XDG_CONFIG_HOME` 等）。
2. **日志格式版本漂移**：各 CLI 更新可能改 JSONL 结构 → 插件需宽松解析 + 错误兜底。
3. **文件并发写入**：读到半行 / 临时文件（`*.jsonl.tmp`）需过滤。
4. **数据保留**：明细无限增长 → 默认保留 N 天明细，历史走日聚合。
5. **去重正确性**：fork/rewrite 双算与漏算的平衡，需样本验证。
6. **插件生命周期**：热装载/卸载的时序与资源泄漏需重点验证。
7. **OpenClaw / Hermes 日志格式（后续阶段）**：需自行调研其本地日志格式与路径，扩展时再做。

## 关联页面

- [项目总览](overview.md) — 目标与技术栈。
- [插件体系](plugin-architecture.md) — M2 的实现对象。
- [监控插件](monitor-plugins.md) — M3/M4 的实现对象。
- [返回目录](../index.md)
