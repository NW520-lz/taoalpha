import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createResearchMcpServer } from "../../src/mcp/research-server.ts";
import type { CliDeps, Envelope } from "../../src/cli.ts";
import { openDb } from "../../src/store/db.ts";
import { createFakeClient } from "../helpers/fake-okx.ts";
import { NOW, marketRoutes, testStrategy } from "../helpers/market-fixtures.ts";
import type { ScanResult } from "../../src/scan/scan.ts";
import type { ResearchRunView, ResearchTask } from "../../src/research/research-service.ts";
import { adversaryReport, fundamentalsReport, marketStructureReport, quantReport, synthesisReport } from "../helpers/research-fixtures.ts";
import { DomainError } from "../../src/lib/errors.ts";

const TOOL_NAMES = ["taoalpha_status", "taoalpha_scan", "taoalpha_bundle", "taoalpha_evidence", "taoalpha_research_start", "taoalpha_research_tasks", "taoalpha_research_submit", "taoalpha_research_get"];

function removeTestDirectory(directory: string): void {
  const target = realpathSync(directory);
  const parent = realpathSync(tmpdir());
  const within = relative(parent, target);
  assert.ok(within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within));
  assert.match(basename(target), /^taoalpha-mcp-/);
  rmSync(target, { recursive: true, force: true });
}

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-mcp-"));
  const strategyPath = join(directory, "strategy.json");
  writeFileSync(strategyPath, JSON.stringify(testStrategy().definition));
  const fake = createFakeClient(marketRoutes());
  const deps: CliDeps = { db: openDb(":memory:"), client: fake.client, now: () => NOW, defaultStrategyPath: strategyPath };
  const server = createResearchMcpServer(deps);
  const client = new Client({ name: "synthetic-research-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    deps.db.close();
    removeTestDirectory(directory);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, deps, directory, calls: fake.calls };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args });
  const envelope = result.structuredContent as unknown as Envelope;
  assert.ok(envelope, "every operation returns a structured research envelope");
  assert.ok(Array.isArray(result.content));
  const [text] = result.content;
  assert.ok(text && text.type === "text");
  assert.deepEqual(JSON.parse(text.text), envelope);
  assert.equal(result.isError === true, envelope.ok === false);
  assert.equal(envelope.mode, "M0_readonly_research");
  return envelope;
}

async function value<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const envelope = await call(client, name, args);
  assert.equal(envelope.ok, true, envelope.summaryZh);
  return envelope.value as T;
}

test("SDK handshake exposes only eight research tools and status performs no market/account reads", async (t) => {
  const { client, calls } = await setup(t);
  assert.equal(client.getServerVersion()?.name, "taoalpha-research");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.readOnlyHint, !["taoalpha_scan", "taoalpha_research_start", "taoalpha_research_submit"].includes(tool.name));
  }
  const result = await call(client, "taoalpha_status");
  assert.equal(result.ok, true);
  assert.equal(result.operation, "status");
  assert.equal(result.asOf, NOW.toISOString());
  assert.deepEqual(result.value, {
    mode: "M0_readonly_research", account: { connected: false, reason: "M0 不读取账户、不使用任何 API 凭证" },
    simulation: "not_implemented", liveTrading: "disabled", exchangeWrites: "none", site: "global", latestBundleId: null,
    offlineBoundary: "关闭客户端后不运行任何研究或监控；M0 没有订单，也没有交易所保护单。",
  });
  assert.deepEqual(calls, []);
});

test("strict protocol inputs reject raw commands, paths, overrides, forged approvals and invalid IDs before business reads", async (t) => {
  const { client, directory, calls } = await setup(t);
  const secretPath = join(directory, "synthetic-private-file-sentinel.txt");
  writeFileSync(secretPath, "synthetic-private-content-sentinel");
  const bundleId = "bundle_00000000-0000-4000-8000-000000000000";
  const runId = "run_00000000-0000-4000-8000-000000000000";
  const assignmentId = "asg_00000000-0000-4000-8000-000000000000";
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["taoalpha_status", { credentials: "synthetic-private-value-sentinel" }],
    ["taoalpha_scan", { strategy: secretPath }], ["taoalpha_scan", { defaultStrategyPath: secretPath }],
    ["taoalpha_scan", { baseUrl: "https://synthetic-override.invalid" }], ["taoalpha_scan", { argv: ["--strategy", secretPath] }],
    ["taoalpha_bundle", { bundleId, top: 0 }], ["taoalpha_bundle", { bundleId, top: -1 }],
    ["taoalpha_bundle", { bundleId, top: 1.5 }], ["taoalpha_bundle", { bundleId, top: "1" }],
    ["taoalpha_bundle", { bundleId, top: Number.MAX_SAFE_INTEGER + 1 }], ["taoalpha_bundle", { bundleId: "../../synthetic-private-file-sentinel" }],
    ["taoalpha_evidence", { evidenceId: "--file" }], ["taoalpha_evidence", { evidenceId: bundleId }],
    ["taoalpha_research_start", { bundleId, agentMode: "swarm" }],
    ["taoalpha_research_start", { bundleId, agentMode: "parallel_independent", hostVerified: true }],
    ["taoalpha_research_tasks", { runId, profile: secretPath }], ["taoalpha_research_tasks", { runId: "" }],
    ["taoalpha_research_get", { runId, approved: true }],
    ["taoalpha_research_submit", { assignmentId, file: secretPath }],
    ["taoalpha_research_submit", { assignmentId, outcome: { kind: "report", report: {}, file: secretPath } }],
    ["taoalpha_research_submit", { assignmentId, outcome: { kind: "failed", reason: "   " } }],
    ["taoalpha_research_submit", { assignmentId, outcome: { kind: "execute", report: {} } }],
    ["taoalpha_research_submit", { assignmentId, outcome: { kind: "failed", reason: "cannot run", report: {} } }],
  ];
  for (const [name, args] of invalid) {
    const envelope = await call(client, name, args);
    assert.equal(envelope.ok, false, name);
    assert.equal(envelope.error?.code, "INVALID_INPUT");
    assert.deepEqual(envelope.error?.violations, [{ ruleId: "mcp.input_schema" }]);
    assert.doesNotMatch(JSON.stringify(envelope), /sentinel|override\.invalid|--strategy|--file/);
  }
  for (const name of ["spot_place_order", "swap_place_order", "taoalpha_approve", "taoalpha_execute", "runCli", "constructor", "__proto__"]) {
    const envelope = await call(client, name, { file: secretPath, approved: true });
    assert.equal(envelope.ok, false);
    assert.deepEqual(envelope.error?.violations, [{ ruleId: "mcp.tool_known" }]);
    assert.doesNotMatch(JSON.stringify(envelope), /sentinel/);
  }
  assert.deepEqual(calls, []);
  assert.equal((await value<{ latestBundleId: string | null }>(client, "taoalpha_status")).latestBundleId, null);
});

test("ordinary validation preserves safe codes/rules while internal errors and backend paths stay private", async (t) => {
  const { client, deps } = await setup(t);
  const missing = await call(client, "taoalpha_bundle", { bundleId: "bundle_00000000-0000-4000-8000-000000000000" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "INVALID_INPUT");
  assert.deepEqual(missing.error?.violations, [{ ruleId: "bundle.exists" }]);
  deps.defaultStrategyPath = "synthetic-private-path-sentinel/missing.json";
  const missingStrategy = await call(client, "taoalpha_scan");
  assert.equal(missingStrategy.ok, false);
  assert.deepEqual(missingStrategy.error?.violations, [{ ruleId: "strategy.readable" }]);
  assert.doesNotMatch(JSON.stringify(missingStrategy), /sentinel|missing\.json/);
  for (const error of [new Error("synthetic-private-stack-sentinel"), new DomainError("DEPENDENCY_UNAVAILABLE", "synthetic-private-domain-sentinel", [{ ruleId: "synthetic-private-rule-sentinel", field: "synthetic-private-field-sentinel" }])]) {
    deps.now = () => { throw error; };
    const envelope = await call(client, "taoalpha_status");
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "DEPENDENCY_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(envelope), /sentinel|stack|node:|\.ts:/);
  }
});

test("partial public-source failures remain explicit without exposing raw network diagnostics through scan or bundle", async (t) => {
  const { client, deps } = await setup(t);
  deps.client = createFakeClient({ ...marketRoutes(), "/api/v5/public/instruments?instType=SPOT": {
    error: { kind: "network", message: "synthetic-private-network-sentinel at C:/private/file.ts:1" },
  } }).client;
  const scan = await value<ScanResult>(client, "taoalpha_scan");
  assert.equal(scan.products.find((product) => product.product === "spot")?.status, "unavailable");
  assert.equal(scan.sourceErrors[0]?.error.kind, "network");
  assert.doesNotMatch(JSON.stringify(scan), /sentinel|C:\/private|\.ts:1/);
  const bundle = await call(client, "taoalpha_bundle", { bundleId: scan.bundleId });
  assert.equal(bundle.ok, true);
  assert.doesNotMatch(JSON.stringify(bundle), /sentinel|C:\/private|\.ts:1/);
});

test("failed roles and invalid structured reports remain auditable without file reads or fabricated host verification", async (t) => {
  const { client } = await setup(t);
  const scan = await value<ScanResult>(client, "taoalpha_scan");
  const run = await value<ResearchRunView>(client, "taoalpha_research_start", { bundleId: scan.bundleId, agentMode: "serial_degraded" });
  const [task] = await value<ResearchTask[]>(client, "taoalpha_research_tasks", { runId: run.runId });
  assert.ok(task);
  for (const report of [{ file: "synthetic-private-file-sentinel" }, marketStructureReport("ev_not_in_bundle")]) {
    const rejected = await call(client, "taoalpha_research_submit", { assignmentId: task.assignmentId, outcome: { kind: "report", report } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "INVALID_INPUT");
    assert.doesNotMatch(JSON.stringify(rejected), /sentinel|ev_not_in_bundle/);
    assert.equal((await value<ResearchTask[]>(client, "taoalpha_research_tasks", { runId: run.runId })).length, 3);
  }
  const failed = { assignmentId: task.assignmentId, outcome: { kind: "failed", reason: "宿主没有可用的独立角色" } };
  const submitted = await value<ResearchRunView>(client, "taoalpha_research_submit", failed);
  assert.equal(submitted.hostVerified, false);
  assert.deepEqual(submitted.missingRoles, [task.role]);
  const conflict = await call(client, "taoalpha_research_submit", { ...failed, outcome: { kind: "failed", reason: "different reason" } });
  assert.equal(conflict.error?.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(conflict.error?.violations, [{ ruleId: "research.assignment_once" }]);
});

test("actual stdio entry handshakes from an unrelated cwd, answers status only and closes its database/process", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-mcp-process-"));
  const dbPath = join(directory, "synthetic.db");
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../src/mcp-main.ts", import.meta.url))], cwd: directory,
    env: { ...getDefaultEnvironment(), TAOALPHA_DB: dbPath }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "synthetic-stdio-host", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "taoalpha-research");
    const pid = transport.pid;
    assert.ok(pid);
    const status = await call(client, "taoalpha_status");
    assert.equal(status.ok, true);
    assert.equal((status.value as { exchangeWrites: string }).exchangeWrites, "none");
    assert.ok(existsSync(dbPath));
    await client.close();
    assert.equal(transport.pid, null);
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i);
    assert.equal(existsSync(`${dbPath}-wal`), false, "graceful database close removes WAL");
    assert.equal(existsSync(`${dbPath}-shm`), false);
    assert.doesNotMatch(stderr, /MCP startup failed|sentinel|Error:|at .*\.ts/);
  } finally {
    await client.close();
    await transport.close();
    removeTestDirectory(directory);
  }
});

test("MCP freezes evidence and completes three research phases with saved sources and non-executable candidate or wait", async (t) => {
  for (const decision of ["trade_candidate", "wait"] as const) {
    await t.test(decision, async (subtest) => {
      const { client, calls } = await setup(subtest);
      const scan = await value<ScanResult>(client, "taoalpha_scan");
      const reference = scan.candidates.find((candidate) => candidate.instId === "GOOD-USDT")?.snapshotEvidenceId;
      assert.ok(reference);
      const bundle = await value<{ bundleId: string; candidates: unknown[]; snapshots: { id: string }[] }>(client, "taoalpha_bundle", { bundleId: scan.bundleId, top: 1 });
      assert.equal(bundle.bundleId, scan.bundleId);
      assert.equal(bundle.candidates.length, 1);
      assert.equal(bundle.snapshots.length, 1);
      const evidence = await value<{ id: string; contentSha256: string }>(client, "taoalpha_evidence", { evidenceId: reference });
      assert.equal(evidence.id, reference);
      assert.match(evidence.contentSha256, /^[a-f0-9]{64}$/);
      const run = await value<ResearchRunView>(client, "taoalpha_research_start", { bundleId: scan.bundleId, agentMode: "parallel_independent" });
      assert.equal(run.hostVerified, false);
      const reports: Record<string, unknown> = {
        market_structure: marketStructureReport(reference), fundamentals_events: fundamentalsReport(reference),
        quant_validation: quantReport(reference), adversary: adversaryReport(reference), synthesis: synthesisReport(reference, { decision }),
      };
      for (const phase of [1, 2, 3]) {
        const tasks = await value<ResearchTask[]>(client, "taoalpha_research_tasks", { runId: run.runId });
        assert.equal(tasks.length, phase === 1 ? 3 : 1);
        for (const task of tasks) {
          assert.equal(task.phase, phase);
          assert.equal(task.bundle.id, scan.bundleId);
          assert.equal(task.bundle.sha256, scan.bundleSha256);
          assert.equal(task.priorReports.length, phase === 1 ? 0 : phase === 2 ? 3 : 4);
          const input = { assignmentId: task.assignmentId, outcome: { kind: "report", report: reports[task.role] } };
          const submitted = await value<ResearchRunView>(client, "taoalpha_research_submit", input);
          assert.equal(submitted.hostVerified, false);
          assert.deepEqual(await value(client, "taoalpha_research_submit", input), submitted, "identical report replay stays idempotent");
        }
      }
      const final = await value<ResearchRunView>(client, "taoalpha_research_get", { runId: run.runId });
      assert.equal(final.status, "decided");
      assert.equal(final.decision?.finalDecision, decision);
      assert.equal(final.hostVerified, false);
      assert.equal((await value<ResearchTask[]>(client, "taoalpha_research_tasks", { runId: run.runId })).length, 0);
      const source = final.reports.find((report) => report.role === "fundamentals_events")?.outcome;
      assert.ok(source?.kind === "report");
      const sourceId = source.sourceEvidenceIds.src1;
      assert.ok(sourceId);
      const savedSource = await value<{ source: string; submittedBy: string }>(client, "taoalpha_evidence", { evidenceId: sourceId });
      assert.equal(savedSource.source, "https://example.com/good-mainnet-upgrade");
      assert.equal(savedSource.submittedBy, `research:${run.runId}:fundamentals_events`);
      if (decision === "trade_candidate") {
        assert.ok(final.decision?.draftCards.length);
        for (const card of final.decision.draftCards) {
          assert.equal(card.executable, false);
          assert.deepEqual(card.readinessBlockers, ["STRATEGY_NOT_VALIDATED", "M0_READ_ONLY"]);
          assert.ok(card.evidenceRefs.includes(reference));
        }
      } else assert.deepEqual(final.decision?.draftCards, []);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((endpoint) => /^\/api\/v5\/(public|market)\//.test(endpoint)));
    });
  }
});
