import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliDeps } from "../src/cli.ts";
import { openDb } from "../src/store/db.ts";
import type { ScanResult } from "../src/scan/scan.ts";
import type { ResearchRunView, ResearchTask } from "../src/research/research-service.ts";
import { createFakeClient } from "./helpers/fake-okx.ts";
import { NOW, marketRoutes, testStrategy } from "./helpers/market-fixtures.ts";
import { adversaryReport, fundamentalsReport, marketStructureReport, quantReport, synthesisReport } from "./helpers/research-fixtures.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "taoalpha-cli-"));
  const strategyPath = join(dir, "strategy.json");
  writeFileSync(strategyPath, JSON.stringify(testStrategy().definition));
  const { client, calls } = createFakeClient(marketRoutes());
  const deps: CliDeps = { db: openDb(":memory:"), client, now: () => NOW, defaultStrategyPath: strategyPath };
  return { deps, dir, calls };
}

async function call<T>(deps: CliDeps, ...argv: string[]): Promise<T> {
  const envelope = await runCli(argv, deps);
  assert.equal(envelope.ok, true, envelope.summaryZh);
  return envelope.value as T;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

async function runAllPhases(deps: CliDeps, dir: string, runId: string, reports: Record<string, unknown>): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const tasks = await call<ResearchTask[]>(deps, "research", "tasks", runId);
    for (const task of tasks) await call(deps, "research", "submit", task.assignmentId, "--file", writeJson(dir, `${task.role}.json`, reports[task.role]));
  }
}

test("status reports M0 read-only mode with no account, simulation or live trading", async () => {
  const { deps } = setup();
  const envelope = await runCli(["status"], deps);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.mode, "M0_readonly_research");
  assert.equal(envelope.asOf, NOW.toISOString());
  assert.deepEqual(envelope.value, {
    mode: "M0_readonly_research",
    account: { connected: false, reason: "M0 不读取账户、不使用任何 API 凭证" },
    simulation: "not_implemented",
    liveTrading: "disabled",
    exchangeWrites: "none",
    site: "global",
    latestBundleId: null,
    offlineBoundary: "关闭客户端后不运行任何研究或监控；M0 没有订单，也没有交易所保护单。",
  });
  assert.match(envelope.summaryZh, /M0 只读研究/);
});

test("unknown commands and bad flags are INVALID_INPUT envelopes with usage", async () => {
  const { deps } = setup();
  for (const argv of [["trade"], [], ["scan", "--bogus"], ["research", "dance"]]) {
    const envelope = await runCli(argv, deps);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "INVALID_INPUT");
    assert.match(envelope.summaryZh, /用法/);
  }
});

test("scan freezes a bundle that bundle --top returns with its snapshot evidence", async () => {
  const { deps } = setup();
  const scanEnvelope = await runCli(["scan"], deps);
  assert.equal(scanEnvelope.ok, true);
  assert.match(scanEnvelope.summaryZh, /排名只是研究候选，不是买卖信号/);
  const scan = scanEnvelope.value as ScanResult;
  const shown = await call<{ candidates: Array<{ snapshotEvidenceId: string }>; snapshots: Array<{ id: string }> }>(deps, "bundle", scan.bundleId, "--top", "1");
  assert.equal(shown.candidates.length, 1);
  assert.deepEqual(shown.snapshots.map((s) => s.id), [shown.candidates[0]?.snapshotEvidenceId]);
  const status = await call<{ latestBundleId: string }>(deps, "status");
  assert.equal(status.latestBundleId, scan.bundleId);
});

test("A02/A03: a full research flow ends in non-executable draft cards with zero exchange writes", async () => {
  const { deps, dir, calls } = setup();
  const scan = await call<ScanResult>(deps, "scan");
  const ref = scan.candidates.find((c) => c.instId === "GOOD-USDT")?.snapshotEvidenceId ?? "";
  const run = await call<ResearchRunView>(deps, "research", "start", "--bundle", scan.bundleId, "--agent-mode", "serial_degraded");
  const firstTasks = await call<ResearchTask[]>(deps, "research", "tasks", run.runId);
  assert.ok(firstTasks.every((t) => t.priorReports.length === 0));

  await runAllPhases(deps, dir, run.runId, {
    market_structure: marketStructureReport(ref),
    fundamentals_events: fundamentalsReport(ref),
    quant_validation: quantReport(ref),
    adversary: adversaryReport(ref),
    synthesis: synthesisReport(ref),
  });

  const final = await runCli(["research", "get", run.runId], deps);
  const view = final.value as ResearchRunView;
  assert.equal(view.status, "decided");
  assert.equal(view.agentMode, "serial_degraded");
  assert.equal(view.decision?.finalDecision, "trade_candidate");
  assert.ok(view.decision?.draftCards.every((c) => c.executable === false));
  assert.match(final.summaryZh, /不可执行/);
  assert.ok(calls.every((endpoint) => endpoint.startsWith("/api/v5/public/") || endpoint.startsWith("/api/v5/market/")));
});

test("A02: choosing a candidate that failed screening ends in wait", async () => {
  const { deps, dir } = setup();
  const scan = await call<ScanResult>(deps, "scan");
  const ref = scan.candidates.find((c) => c.instId === "WIDE-USDT")?.snapshotEvidenceId ?? "";
  const run = await call<ResearchRunView>(deps, "research", "start", "--bundle", scan.bundleId, "--agent-mode", "parallel_independent");
  await runAllPhases(deps, dir, run.runId, {
    market_structure: marketStructureReport(ref),
    fundamentals_events: fundamentalsReport(ref),
    quant_validation: quantReport(ref),
    adversary: adversaryReport(ref),
    synthesis: synthesisReport(ref, { candidates: [{ instId: "WIDE-USDT", product: "spot", direction: "long" }] }),
  });
  const final = await runCli(["research", "get", run.runId], deps);
  assert.equal((final.value as ResearchRunView).decision?.finalDecision, "wait");
  assert.match(final.summaryZh, /降级原因/);
});

test("submit rejects ambiguous flags and unreadable or malformed report files", async () => {
  const { deps, dir } = setup();
  const scan = await call<ScanResult>(deps, "scan");
  const run = await call<ResearchRunView>(deps, "research", "start", "--bundle", scan.bundleId, "--agent-mode", "serial_degraded");
  const [task] = await call<ResearchTask[]>(deps, "research", "tasks", run.runId);
  assert.ok(task);
  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, "{ nope");
  const both = await runCli(["research", "submit", task.assignmentId, "--file", malformed, "--failed", "x"], deps);
  assert.equal(both.error?.code, "INVALID_INPUT");
  const bad = await runCli(["research", "submit", task.assignmentId, "--file", malformed], deps);
  assert.deepEqual(bad.error?.violations, [{ ruleId: "cli.file_json", field: "file" }]);
  const missing = await runCli(["research", "submit", task.assignmentId, "--file", join(dir, "missing.json")], deps);
  assert.deepEqual(missing.error?.violations, [{ ruleId: "cli.file_readable", field: "file" }]);
});
