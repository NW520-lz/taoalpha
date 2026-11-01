# 策略评价链：门槛、稳健性与最终报告

本文描述在[趋势回放](TREND_CANDLE_REPLAY.md)之上的内部评价接口。它们只读本地登记与历史清单，不连接账户或交易所，结果始终 `executionAuthorized: false`。所有门槛数值由登记人在实验登记中提供，代码不设默认值；改动任何门槛都必须使用新的实验版本。

## 结构化门槛与探索→验证判定

实验登记的可选 `gates` 字段（需同时登记 `replay`）冻结评价门槛，并纳入内容哈希：

| 字段 | 含义 |
| --- | --- |
| `minRealizedTrades` | 探索窗口最少已实现交易数 |
| `maxValidationDecay` | 验证段相对探索段的最大衰减率 |
| `normalizationDays` | 衰减比较前把各窗口净收益换算为每 N 天 |
| `requirePositiveNet` | 验证段（及之后的最终评价段）扣成本净收益必须为正 |

`judgeValidation(db, registry, {experimentId, version, expected})` 回放探索和验证窗口，把两段净收益按窗口时长归一，衰减率 =（探索 − 验证）/ 探索，十位小数四舍六入五成双。判定 `validationGate`：

- `failed`：探索段扣成本不为正（此时衰减率为 `null`，不做除法）；要求为正时验证段不为正；衰减率超过上限。
- `insufficient`：任一窗口缺少数据；探索段已实现交易少于最少数；验证段没有已实现交易。
- `met`：以上都不成立。

`reasons` 先列失败原因，再列不足原因。只有文字门槛的登记返回 `blocked` / `rules_incomplete`。本接口不产生 `passed`，整体状态仍为 `insufficient`；验证窗口可以重复查看，查看次数不记录。
