# Demo risk policy confirmation (internal backend)

`createDemoRiskPolicyService(db, session, confirmations, now)` accepts only a process-owned demo account session and confirmation service sharing the same SQLite connection. Do not construct these dependencies from a request, or expose this service to research MCP. A separate trusted local UI must call `confirmations.reviewAndConfirm(requestId)`; this service never invokes a prompt or accepts an approval claim.

- `propose({ proposalId, policy, expiresAt })` freezes the entire strict policy and unreconciled baseline status into the confirmation subject. Stable references are idempotent only for identical content and account binding.
- `confirm(proposalId, receiptId)` validates the current account binding and latest successful refresh within a SQLite immediate transaction, consumes the exact receipt and appends a confirmation in that transaction. Versions strictly increase within a scope.
- `get(proposalId)` returns safe metadata and pending/confirmed status. Summaries omit policy amounts and receipt IDs.

Policy contains a user-proposed `initialEquityUsdt`, three USDT budgets (`reserve`, `spot`, `perpetual`), increasing USDT loss lines (`review`, `pause`, `stop`), and explicit asset/position, plan-loss and leverage limits. Amounts are plain decimal strings with a 40-character bound. Budget addition uses 100 significant digits: at most 40 integer digits, 38 fractional digits, and one carry fit within this bound without rounding. No values are inferred or supplied by default. This amount is not a reconciled account balance, capital history or ledger baseline; aggregate USD equity is not converted to USDT. Confirmation always reports `reconciled: false`, `executionAuthorized: false`, and `blockNewRisk: true`. It neither clears existing risk events nor approves a trade. The native human-presence UI and end-to-end demo verification are separate work.

SQLite append-only triggers guard the policy tables under the existing `recursive_triggers` setting. This is not protection against malicious code with the same OS/database privileges. The confirmation provider must display the complete subject and its hash and verify real user presence; synthetic providers are test-only.

