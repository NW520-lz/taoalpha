# OKX demo 只读连接检查

当前只接入固定版本 Trade Kit 的 demo 只读入口。检查命令读取账户配置、余额、永续仓位、现货/永续在途订单及条件保护单；对分页失败、数据错误或能力不符返回缺口。它不会提交、撤销、修改订单或设置杠杆。

## 本机配置

在 OKX **模拟交易账户**创建专用 API Key。当前检查只需读取权限。凭证在本机编辑器填写到 `%USERPROFILE%\.okx\config.toml`（其他系统为 `~/.okx/config.toml`），不发到聊天、不加入仓库：

```toml
[profiles.taoalpha_demo]
api_key = ""       # 在本机填写
secret_key = ""    # 在本机填写
passphrase = ""    # 在本机填写
demo = true
site = "REPLACE_WITH_REGISTERED_SITE"

# 可选：实盘凭证独立保存；当前 TaoAlpha 不读取此 profile、不启用实盘交易。
[profiles.taoalpha_live]
api_key = ""
secret_key = ""
passphrase = ""
demo = false
site = "REPLACE_WITH_REGISTERED_SITE"
```

两套 API 凭证分别在对应环境创建，不能混用。`demo:check` 必须选用 `taoalpha_demo`，选择 `demo = false` 的 profile 会被拒绝。交易所返回 `50101` 表示 API Key 与请求环境不匹配，应核对模拟环境凭证，而不是把检查改成实盘。

`site` 必须使用账户实际注册站点，不能按当前 IP 猜测：

| 站点值 | 用户账户站点 | 固定 API Origin |
| --- | --- | --- |
| `global` | www.okx.com | https://www.okx.com |
| `eea` | my.okx.com | https://eea.okx.com |
| `us` | app.okx.com | https://us.okx.com |
| `tr` | tr.okx.com | https://tr.okx.com |

连接器要求 profile 明确包含 `demo = true`、匹配的 `site` 和三项完整凭证。自定义 `base_url` 只能等于该站点的官方 Origin；不允许把它改到其他服务器。可选 `proxy_url` 支持 HTTP/HTTPS；凭证与代理地址不会出现在检查输出中。

## 运行

安装项目依赖后，在仓库根目录运行。以下命令以实际注册在 global 的账户为例，其他站点相应替换 `--site`：

```bash
npm run demo:check -- --profile taoalpha_demo --site global
```

输出只包含 demo 环境、各读取项状态、页数、记录数及 `accountValidation` 固定校验状态/规则，不展示余额、账户标识、订单号或仓位正文。`ok` 同时要求读取完整与字段归一校验成功；接口可读取但字段、来源或时效无效也返回失败。缺少本机配置时返回 `tradekit.profile_readable`；站点、demo 标记、版本、权限或读取项有问题时返回明确失败，退出码为 1。

即使各项读取和字段校验完成，输出仍是 `reconciled: false`、`executionAuthorized: false`、`blockNewRisk: true`：外部资金流水、受管/手动仓位归属、自动追加保证金、合约估值、保护覆盖与已确认风险配置尚待完整核对。识别账户模式不等于已经验证其适合执行。当前接口没有将“API 可读取”转换成交易批准，也没有真实 demo 订单验收。

归一化数据只保留在后端内存。账户 `totalEq` 是 **USD 权益**，不能当成受管 USDT 本金或直接用于累计盈亏账本；币种权益保留币种单位，永续仓位数量保留合约张数，未用缺失的合约面值推算币数量。数值使用十进制字符串，缺失值不会补成零。

来源校验要求各页端点匹配固定 GET 路径。读取观察时间 `requestTime` 最多早于检查时刻 30 秒、最多超前 5 秒，边界包含；这是本机读取时效校验，不是交易所时钟证明。余额和仓位 `uTime` 是交易所最后更新时间，未变化账户可有较早时间，不按读取时效误判。多接口读取也不代表原子账户快照。

## 固定版本与验证边界

- 官方来源：[okx/agent-trade-kit](https://github.com/okx/agent-trade-kit)，本次源码核对提交 `e5b60e4f0bc2afc75fab19c8360dafa6b84f3ed7`；公开包固定 `@okx_ai/okx-trade-mcp@1.5.0`，许可证 MIT。
- TaoAlpha 使用私有 stdio MCP 连接，启动参数固定 demo、read-only、account/spot/swap 模块，并核验握手版本、实际能力和工具清单。研究入口不获得上游原始工具调用权。当前官方 CLI/core 通用 runner 会关闭其 `readOnly` 标志，因此不将它作为 TaoAlpha 的读取权限边界。
- 凭证文件在 TaoAlpha 本机适配器内用 `smol-toml@1.9.1` 校验；子进程使用隔离空目录和专用环境变量，不重新解析原始配置，不在参数或临时文件中写入凭证。SDK 固定 `1.32.2`。依赖树审计不覆盖发布包中内嵌的库，不能单凭 `npm audit` 断言整个上游没有漏洞。
- 自动化已覆盖合成数据读取、完整分页/重复页、错误不当空结果、环境/端点/版本错误、输出脱敏，以及真实已安装 MCP 进程的本机握手。该握手使用合成凭证且不访问交易所；它不能替代真实 demo 账户读取和订单闭环。

完整 M1 开发进度见 [M1_IMPLEMENTATION.md](M1_IMPLEMENTATION.md)，执行与风险规则见 [INVARIANTS.md](INVARIANTS.md)。

本次实际运行结果见[账户字段归一验证记录](validation/2026-10-28-m1-account-readonly.md)，不代表后续任意时刻的连接状态或完整 M1 验收。
