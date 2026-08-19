---
type: pricing-design
title: 定价与费用
description: 内置模型定价表，费用 = 各类 token × 每百万价格；模型 ID 需先归一化再查价。
tags: [pricing, cost, token, model]
timestamp: 2026-08-19T20:25:00+08:00
---

# 定价与费用

> [!note] 当前状态
> 规划阶段。定价机制为设计，暂无 seed 数据与实现。

## 定价表

`model_pricing` 记录每百万 token 价格：input / output / cache_read / cache_creation（默认 USD），并支持自定义/覆盖。

## 费用计算

估算费用 = 各类 token 数 × 对应每百万价格，可叠加可配置 `cost_multiplier`。

## 模型 ID 归一化

查价前先清洗模型 ID（自研规则）：

- 去掉最后一个 `/` 之前的供应商前缀，转小写；
- 去掉 `:` 之后的后缀、末尾 `[1m]`；
- `@` → `-`；
- 去掉常见包装前缀、版本后缀、日期后缀（`-YYYY-MM-DD`、`-YYYYMMDD`）；
- 部分模型族支持短 ID 匹配带版本的定价项。

## 内置价格来源

内置常见模型定价（Claude / OpenAI-GPT / Gemini / 国产模型等），价格以各厂商公开定价为准；可选后续接 models.dev 自动同步。

> [!todo] 待补充
> - 具体内置定价清单与币种（USD/CNY）尚未落地。
> - 归一化函数需配单测，M2/M3 实现时补充。

## 关联页面

- [数据模型](data-model.md) — `model_pricing` 表结构。
- [数据流](data-flow.md) — 费用计算在链路中的位置。
- [返回目录](../index.md)
