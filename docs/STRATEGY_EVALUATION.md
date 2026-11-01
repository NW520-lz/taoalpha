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

## 成本压力与基准

`gates.costStressMultipliers` 冻结一组严格递增、首项为 1 的整数倍数（最多 10 个）。登记时检查放大后的每端手续费或冲击不超过名义金额的 100%。`compareWithBaselines(db, registry, {experimentId, version, expected, window})` 对探索或验证窗口返回：

- `costStress`：手续费与冲击各乘以倍数后重新回放的窗口指标，各端仍只计一次。
- `hold`：用同样数量和成本模型，在窗口第一根开盘买入、最后一根收盘卖出；缺口期间继续持有；回撤按逐根收盘的毛估值从 0 起算。它是逐根估值，而策略回撤只按已实现出场计算，两者口径不同。
- `noTrade`：净收益与回撤均为 0。

未登记倍数时返回 `blocked` / `rules_incomplete`；最终评价窗口仍封存。

## 参数邻域敏感性

`gates.sensitivity` 冻结：每个参数的邻域取值（`breakoutLookback`、`atrPeriod`、`initialStopAtr`、`trailingStopAtr` 中至少一个；显式列出、严格递增、至少两个且必须包含登记值，因此整数取整规则也一并冻结），可选的止损二维网格，相邻点最大相对变化 `maxAdjacentChange`，以及是否要求所有点扣成本为正。

`assessParameterSensitivity(db, registry, {experimentId, version, expected})` 只在探索窗口上逐一替换单个参数回放，其余参数保持登记值。接口没有窗口参数，验证与最终评价窗口不能被扫描。每个参数返回各点净收益与相邻相对变化（任一侧无已实现交易或基数为 0 时为 `null`）。判定 `sensitivityGate`：相邻变化超限或（要求时）存在不为正的点为 `failed`；存在没有已实现交易的点为 `insufficient`；否则 `met`。

止损网格只报告不判定，每格标明 `initialStopCanBind`：移动止损从入场价起算，当移动倍数不大于初始倍数时初始止损永远不会生效，该格实际只在测移动止损。`attempts` 是从登记枚举出的全部尝试数，报告列出所有点而不是最优点。

## 一次性最终评价报告

`runFinalEvaluation(db, registry, {experimentId, version, expected}, now)` 是唯一能打开最终评价窗口的接口。它要求登记中已有 `replay`、`sensitivity`、`costStressMultipliers`、`costStressMustStayPositiveAt`（须在倍数列表中）和 `requireBeatHold`；缺任何一项返回 `blocked` / `rules_incomplete`，不保存任何内容，也不消耗这一次运行。

满足条件时，它一次性计算：探索→验证判定、参数敏感性（含全部尝试）、最终评价窗口的指标、成本压力与持有/不交易基准。最终评价窗口判定 `evaluationGate`：无数据或无已实现交易为 `insufficient`；要求为正而净收益不为正、要求跑赢持有而净收益不高于持有、或在登记倍数的成本下净收益不为正，为 `failed`。

整体 `status`：任一判定失败为 `failed`；三项全部达标（`gatesMet: true`）且没有证据缺口才是 `passed`。当前历史清单始终缺少历史可获知时间和历史标的池（`evidenceGaps`），因此 `passed` 暂时不可达，即使全部达标也只能是 `insufficient`。`passed` 只表示历史回放范围，不代表模拟或实盘准入；报告注明交易不是独立样本。

报告以规范 JSON 和 SHA-256 保存到 `final_evaluation_reports`，每个实验版本一行，更新和删除由触发器禁止。再次调用（包括不同时钟）返回已保存的同一份报告；并发时先写入者的报告胜出。读取时校验哈希。报告内容来自本地登记与清单，不代表事前登记已被可信时间戳证明。
