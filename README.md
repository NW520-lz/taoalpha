# TaoAlpha · 道枢

**让 Agent 辩论，让规则裁决，让你决定。**

TaoAlpha 是面向 Codex / Claude Code 的开源加密资产研究与人工确认交易框架。计划中的第一版支持 OKX 现货与 USDT 线性永续：多个研究角色提供可追溯的证据和异议，后端生成交易卡，用户逐单批准，受控执行端按风险规则下单并核对结果。

**状态：工程设计阶段。** 本仓库目前没有可运行的交易程序、已验证策略或实盘能力。请从以下文档了解系统边界：

- [项目地图](docs/PROJECT_MAP.md)：模块和数据流。
- [不可破坏的约束](docs/INVARIANTS.md)：资金、授权、保护与恢复规则。
- [架构决策](docs/DECISIONS.md)：选择与取舍。
- [验证方案](docs/EVALS.md)：怎样证明系统和策略达到各阶段要求。
- [Agent 协作约定](AGENTS.md)：项目级工作规则。

预定交付顺序为只读研究、OKX 模拟环境闭环、单独审阅后的人工确认实盘。研究意见可以是**等待**或**放弃**；多 Agent 共识与《德道经》的纪律启发不构成收益证明。

Project status: design only. No trading software, validated strategy, or live trading capability is published yet.

License: MIT. See [LICENSE](LICENSE).
