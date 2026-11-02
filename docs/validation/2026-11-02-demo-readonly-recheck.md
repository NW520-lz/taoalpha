# OKX demo 只读连接复核（2026-11-02）

证据类型：**真实 OKX global 模拟账户的只读读取**，通过固定版本 Trade Kit `@okx_ai/okx-trade-mcp@1.5.0` 的私有 demo/read-only 连接，命令 `npm run demo:check -- --profile taoalpha_demo --site global`。输出只含读取状态、页数与条数，不含余额、账户标识或订单内容。不是下单、对账或订单闭环验收。

## 结果

| 读取项 | 状态 | 页数 | 条数 |
| --- | --- | --- | --- |
| 账户配置 | ok | 1 | 1 |
| 余额 | ok | 1 | 1 |
| 永续持仓 | ok | 1 | 0 |
| 现货在途单 | ok | 1 | 0 |
| 永续在途单 | ok | 1 | 0 |
| 现货条件单（conditional / oco / move_order_stop） | ok | 3 | 0 |
| 永续条件单（同上） | ok | 3 | 0 |

字段归一校验 `ok`。共运行四次：第一次永续条件单读取失败，检查如实判为读取不完整并保持阻断；之后三次全部读取完整。失败原因被读取器统一折叠为 `read_failed_or_incomplete`，未进一步区分（可能是一次性的网络或接口错误）。

## 边界

输出仍为 `reconciled: false`、`executionAuthorized: false`、`blockNewRisk: true`。以下仍未核对：资金流水、受管持仓归属、自动追加保证金、合约估值、保护覆盖、已确认风险配置。账户当前没有在途单、条件单和永续持仓，因此 [demo 对账](../M1_IMPLEMENTATION.md) 中的"非受管订单/持仓"检查在真实账户上尚未遇到非空情形。
