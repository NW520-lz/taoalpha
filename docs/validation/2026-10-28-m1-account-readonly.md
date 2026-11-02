# M1 demo 账户字段归一验证记录

日期：2026-10-28（America/New_York）。源码提交：`d58e86523f6a07cccb862cc82997d3cf8e33c9d2`。环境：本机 Node.js 24、固定 `@okx_ai/okx-trade-mcp@1.5.0`、OKX global demo、read-only。

本记录只证明下列读取和字段校验实际运行，不代表资金对账、策略有效、M1 订单闭环或实盘准入。公开记录只保留状态，不保留账户身份、金额、仓位、币种清单、订单号或凭证。

## 本地合成测试

- `npm test`：139/139 通过，0 失败、0 跳过。
- `npm run typecheck`：退出码 0。
- 新增 `test/account/demo-account.test.ts` 并扩展 `test/demo-check.test.ts`：账户模式、精确十进制字符串、USD/币种/合约单位、空账户、重复/缺失/非法字段、净仓方向、未支持产品、来源端点、读取时间边界、失败计数与输出脱敏。测试先观察失败再实施；合成测试不访问真实交易所。
- CodeGraph 更新后覆盖 51 个 TypeScript 文件；影响路径为 `normalizeDemoAccount` → `runDemoCheck` → `demo-main` 及对应测试。静态调用图不代替测试或账户对账。

## 真实 demo 连续三轮

各轮运行同一命令：

```bash
npm run demo:check -- --profile taoalpha_demo --site global
```

预期：7 类只读查询完成、配置/权益/仓位字段与各页来源/读取时效校验通过，同时继续禁止执行和标明未完成核对。

| 轮次 | 开始时间（UTC） | 退出码 | 连接及字段校验 | 执行/对账边界 |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-29T02:07:21Z | 0 | `ok=true`、`connectivityOk=true`、`accountValidation.status=ok` | `executionAuthorized=false`、`reconciled=false`、`blockNewRisk=true` |
| 2 | 2026-10-29T02:07:26Z | 0 | 同上 | 同上 |
| 3 | 2026-10-29T02:07:30Z | 0 | 同上 | 同上 |

实际：3/3 达到本次预期，校验失败项为空。命令固定 demo/read-only，不提供提交、修改或撤销订单的入口；本次未执行交易动作。本次只验收 global，其他注册站点未测试。

## 仍缺少的证据

`capital_history`、`managed_ownership`、`auto_add_margin_verification`、`contract_metadata_valuation`、`protected_coverage`、`approved_risk_config` 均保持缺口。尚未建立或确认个人本金基准，没有把 USD 权益写成受管 USDT 净值，也没有接入真实累计亏损计算。

账户模式识别和空仓读取不能证明带仓账户或在途/保护订单的真实语义已验收；这些边界目前有合成测试或读取契约，真实非空订单、部分成交、保护覆盖与异常恢复仍待独立 demo 验收。无历史策略验证、交易卡/可信批准、原子预留及执行协调器证据，不得开放交易。

相关说明：[配置与读取边界](../OKX_DEMO_SETUP.md)、[M1 开发记录](../M1_IMPLEMENTATION.md)、[验收方案](../EVALS.md)。
