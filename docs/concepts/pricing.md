---
type: pricing-design
title: 定价与费用
description: 内置模型定价表，费用 = 各类 token × 每百万价格；模型 ID 需先归一化再查价。
tags: [pricing, cost, token, model]
resource: src/main/services/pricing.ts
timestamp: 2026-08-21T23:41:51+08:00
---

# 定价与费用

> [!note] 当前状态
> **已实现**（2026-08-20）。归一化与费用计算落地于 `src/main/services/pricing.ts`（含内置 seed 定价），单测见 `pricing.test.ts`。

## 定价表（已实现）

`model_pricing` 记录每百万 token 价格：input / output / cache_read / cache_creation，含 `currency`（默认 USD）与 `cost_multiplier`（默认 1），支持自定义/覆盖（IPC 更新/删除后失效 pricing 内存缓存）。

## 费用计算（已实现）

估算费用 = 各类 token 数 × 对应每百万价格 × cost_multiplier，按微美元整数精度求和后输出 USD 字符串；未找到定价项返回 undefined（记录照常入库，costUsd 为空）。

## 模型 ID 归一化（已实现，7 步规则）

查价前先清洗模型 ID（自研规则，按序执行）：

1. trim + 转小写；
2. 去掉最后一个 `/` 之前的供应商前缀；
3. 去掉 `:` 之后的后缀（`model:suffix → model`）；若冒号前为已知供应商名则改为保留冒号后（`provider:model → model`）；
4. 去掉末尾 `[1m]`；
5. `@` → `-` 并去掉开头 `-`；
6. 去掉常见包装前缀（`provider.model` / `provider_model` → model，供应商名单内置 19 个）；
7. 去掉版本/日期后缀（`-YYYY-MM-DD`、`-YYYYMMDD`）。

匹配策略：先精确匹配归一化 ID；未命中按「短 ID 匹配带版本项」兜底——请求 ID 以定价 key 为前缀且后继为边界字符（`-`、`.`、数字）时命中，取最长 key，避免家族误配（如 `gpt-4o-latest → gpt-4o`）。

## 内置 seed 价格清单（已落地）

启动时经 `seedPricing` upsert 写入 **10 个模型**（币种 USD，公开参考价，已存在 model_id 则覆盖更新）：

| model_id | provider | input | output | cache_read | cache_creation |
|---|---|---|---|---|---|
| claude-opus-4-1 | anthropic | 15 | 75 | 1.5 | 18.75 |
| claude-sonnet-4-5 | anthropic | 3 | 15 | 0.3 | 3.75 |
| claude-3-5-haiku | anthropic | 0.8 | 4 | 0.08 | 1 |
| gpt-4.1 | openai | 2 | 8 | 0.5 | 2 |
| gpt-4o | openai | 2.5 | 10 | 1.25 | 2.5 |
| gpt-4o-mini | openai | 0.15 | 0.6 | 0.075 | 0.15 |
| gemini-2-5-pro | google | 1.25 | 10 | 0.3125 | 1.25 |
| gemini-2-5-flash | google | 0.3 | 2.5 | 0.075 | 0.3 |
| grok-4 | x-ai | 3 | 15 | 0.3 | 3 |
| deepseek-chat | deepseek | 0.27 | 1.1 | 0.07 | 0.27 |

> 单位：USD / 每百万 token。可选后续接 models.dev 自动同步。

## 关联页面

- [数据模型](data-model.md) — `model_pricing` 表结构。
- [数据流](data-flow.md) — 费用计算在链路中的位置。
- [返回目录](../index.md)
