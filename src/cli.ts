import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DomainError, type ErrorCode, type Violation } from "./lib/errors.ts";
import type { PublicClient } from "./okx/public-client.ts";
import type { Db } from "./store/db.ts";
import { getBundle, getEvidence, latestBundleId } from "./store/evidence-store.ts";
import { loadStrategy } from "./scan/strategy.ts";
import { runScan, type ScanCandidate, type ScanContent, type ScanResult } from "./scan/scan.ts";
import {
  completeTask,
  getRun,
  nextTasks,
  startResearch,
  type AgentMode,
  type ResearchRunView,
  type ResearchTask,
  type SubmittedOutcome,
} from "./research/research-service.ts";

export interface CliDeps {
  db: Db;
  client: PublicClient;
  now: () => Date;
  defaultStrategyPath: string;
}

export interface Envelope {
  ok: boolean;
  operation: string;
  mode: "M0_readonly_research";
  asOf: string;
  value?: unknown;
  error?: { code: ErrorCode; message: string; violations: Violation[] };
  summaryZh: string;
}

interface Output {
  value: unknown;
  summaryZh: string;
}

const USAGE =
  "用法：status | scan [--strategy <path>] | bundle <bundleId> [--top <n>] | evidence <evidenceId> | " +
  "research start --bundle <id> --agent-mode <parallel_independent|serial_degraded> | research tasks <runId> | " +
  "research submit <assignmentId> (--file <report.json> | --failed <reason>) | research get <runId>";

const STATUS_ZH: Record<ResearchRunView["status"], string> = {
  independent_research: "独立研究",
  challenge: "反方质询",
  synthesis: "主控综合",
  decided: "已形成结论",
};

const STATE_ZH: Record<ResearchRunView["assignments"][number]["state"], string> = {
  open: "待完成",
  completed: "已提交",
  failed: "未能运行",
};

export async function runCli(argv: string[], deps: CliDeps): Promise<Envelope> {
  const asOf = deps.now().toISOString();
  const operation = argv.slice(0, argv[0] === "research" ? 2 : 1).join(" ") || "(none)";
  try {
    const { value, summaryZh } = await dispatch(argv, deps);
    return { ok: true, operation, mode: "M0_readonly_research", asOf, value, summaryZh };
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    return {
      ok: false,
      operation,
      mode: "M0_readonly_research",
      asOf,
      error: { code: err.code, message: err.message, violations: err.violations },
      summaryZh: `失败（${err.code}）：${err.message}`,
    };
  }
}

async function dispatch(argv: string[], deps: CliDeps): Promise<Output> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return status(deps);
    case "scan":
      return scan(rest, deps);
    case "bundle":
      return bundle(rest, deps);
    case "evidence":
      return evidence(rest, deps);
    case "research":
      return research(rest, deps);
    default:
      throw usageError(`unknown command: ${command ?? "(none)"}`);
  }
}

function status(deps: CliDeps): Output {
  const latest = latestBundleId(deps.db);
  const offlineBoundary = "关闭客户端后不运行任何研究或监控；M0 没有订单，也没有交易所保护单。";
  return {
    value: {
      mode: "M0_readonly_research",
      account: { connected: false, reason: "M0 不读取账户、不使用任何 API 凭证" },
      simulation: "not_implemented",
      liveTrading: "disabled",
      exchangeWrites: "none",
      site: deps.client.site,
      latestBundleId: latest,
      offlineBoundary,
    },
    summaryZh: [
      "模式：M0 只读研究（仅 OKX 公共行情）",
      "账户：未连接（不使用任何凭证）",
      "模拟：未实现；实盘：禁用；交易所写请求：无",
      `最新证据包：${latest ?? "无"}`,
      offlineBoundary,
    ].join("\n"),
  };
}

async function scan(args: string[], deps: CliDeps): Promise<Output> {
  const { values } = parse(args, { strategy: { type: "string" } });
  const strategy = loadStrategy(stringOption(values, "strategy") ?? deps.defaultStrategyPath);
  const result = await runScan(deps.db, deps.client, strategy, deps.now);
  return { value: result, summaryZh: scanSummary(result) };
}

function bundle(args: string[], deps: CliDeps): Output {
  const { values, positionals } = parse(args, { top: { type: "string" } });
  const id = positionals[0];
  if (!id) throw usageError("bundle requires <bundleId>");
  const stored = getBundle(deps.db, id);
  if (!stored) throw new DomainError("INVALID_INPUT", `unknown evidence bundle ${id}`, [{ ruleId: "bundle.exists", field: "bundleId" }]);
  const content = stored.content as ScanContent;
  const top = positiveInt(stringOption(values, "top")) ?? content.candidates.length;
  const candidates = content.candidates.slice(0, top);
  const snapshots = candidates.map((c) => getEvidence(deps.db, c.snapshotEvidenceId));
  return {
    value: { bundleId: stored.id, bundleSha256: stored.contentSha256, ...content, candidates, snapshots },
    summaryZh: `证据包 ${stored.id}：共 ${content.candidates.length} 个候选，显示前 ${candidates.length} 个及其行情快照证据。`,
  };
}

function evidence(args: string[], deps: CliDeps): Output {
  const { positionals } = parse(args, {});
  const id = positionals[0];
  if (!id) throw usageError("evidence requires <evidenceId>");
  const item = getEvidence(deps.db, id);
  if (!item) throw new DomainError("INVALID_INPUT", `unknown evidence ${id}`, [{ ruleId: "evidence.exists", field: "evidenceId" }]);
  return { value: item, summaryZh: `证据 ${item.id}（${item.kind}，${item.label}）来源：${item.source}` };
}

async function research(args: string[], deps: CliDeps): Promise<Output> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start": {
      const { values } = parse(rest, { bundle: { type: "string" }, "agent-mode": { type: "string" } });
      const bundleId = stringOption(values, "bundle");
      const agentMode = stringOption(values, "agent-mode");
      if (!bundleId || !agentMode) throw usageError("research start requires --bundle and --agent-mode");
      const view = startResearch(deps.db, { bundleId, agentMode: agentMode as AgentMode }, deps.now);
      return { value: view, summaryZh: runSummary(view) };
    }
    case "tasks": {
      const runId = parse(rest, {}).positionals[0];
      if (!runId) throw usageError("research tasks requires <runId>");
      const tasks = nextTasks(deps.db, runId);
      return { value: tasks, summaryZh: tasksSummary(tasks) };
    }
    case "submit": {
      const { values, positionals } = parse(rest, { file: { type: "string" }, failed: { type: "string" } });
      const assignmentId = positionals[0];
      const file = stringOption(values, "file");
      const failed = stringOption(values, "failed");
      if (!assignmentId || (file === undefined) === (failed === undefined)) {
        throw usageError("research submit requires <assignmentId> and exactly one of --file or --failed");
      }
      const outcome: SubmittedOutcome = file !== undefined ? { kind: "report", report: readJson(file) } : { kind: "failed", reason: failed ?? "" };
      const view = completeTask(deps.db, { assignmentId, outcome }, deps.now);
      return { value: view, summaryZh: runSummary(view) };
    }
    case "get": {
      const runId = parse(rest, {}).positionals[0];
      if (!runId) throw usageError("research get requires <runId>");
      const view = getRun(deps.db, runId);
      return { value: view, summaryZh: runSummary(view) };
    }
    default:
      throw usageError(`unknown research command: ${sub ?? "(none)"}`);
  }
}

function scanSummary(result: ScanResult): string {
  const lines = [
    `证据包 ${result.bundleId}（策略 ${result.strategy.id} v${result.strategy.version}，验证状态：未验证）`,
    result.screening === "applied" ? "可执行性筛选：已按策略阈值筛选" : "可执行性筛选：未配置阈值，以下仅为事实排名，未经可执行性筛选",
    ...result.products.map((p) =>
      p.status === "ok"
        ? `${p.product}：可交易 ${p.liveInstruments}，缺行情 ${p.missingTicker}，入围 ${p.shortlisted}`
        : `${p.product}：不可用（数据源失败）`,
    ),
  ];
  if (result.sourceErrors.length > 0) {
    lines.push(`数据源失败 ${result.sourceErrors.length} 项：${result.sourceErrors.map((e) => e.endpoint).join("；")}（失败不代表没有风险或没有事件）`);
  }
  lines.push(
    "前 5 名：",
    ...result.candidates
      .slice(0, 5)
      .map((c) => `- ${c.instId}（${c.product}）24h ${c.change24hPct ?? "?"}%，成交额 ${c.turnover24hUsdt ?? "?"} USDT ${screenLabel(c)}`),
    "排名只是研究候选，不是买卖信号。",
  );
  return lines.join("\n");
}

function screenLabel(candidate: ScanCandidate): string {
  if (candidate.screening.state === "not_configured") return "[未筛选]";
  if (candidate.screening.passed) return "[通过筛选]";
  return `[未通过：${candidate.screening.checks.filter((c) => !c.pass).map((c) => c.rule).join(", ")}]`;
}

function tasksSummary(tasks: ResearchTask[]): string {
  if (tasks.length === 0) return "没有待完成的任务（研究已形成结论）。";
  return [`${tasks.length} 个待完成任务（第 ${tasks[0]?.phase} 阶段）：`, ...tasks.map((t) => `- ${t.role}：${t.assignmentId}`)].join("\n");
}

function runSummary(view: ResearchRunView): string {
  const lines = [
    `研究运行 ${view.runId}：${STATUS_ZH[view.status]}；宿主运行方式（自报，未核验）：${view.agentMode}`,
    ...view.assignments.map((a) => `- ${a.role}（第 ${a.phase} 阶段）：${STATE_ZH[a.state]}`),
  ];
  if (view.missingRoles.length > 0) lines.push(`缺失角色：${view.missingRoles.join(", ")}`);
  const decision = view.decision;
  if (decision) {
    lines.push(`最终结论：${decision.finalDecision}（主控：${decision.synthesisDecision}）${decision.downgradeReason ? `；降级原因：${decision.downgradeReason}` : ""}`);
    for (const card of decision.draftCards) {
      lines.push(`- 草案卡 ${card.draftId} ${card.instId} ${card.direction}：不可执行；阻断：${[...card.hardBlockers, ...card.readinessBlockers].join(", ")}`);
    }
    if (decision.waitConditions.length > 0) lines.push(`等待条件：${decision.waitConditions.join("；")}`);
  }
  return lines.join("\n");
}

function parse(args: string[], options: Record<string, { type: "string" }>) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
}

function stringOption(values: Record<string, unknown>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw usageError(`--top must be a positive integer, got ${value}`);
  return Number(value);
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DomainError("INVALID_INPUT", `cannot read ${path}`, [{ ruleId: "cli.file_readable", field: "file" }]);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new DomainError("INVALID_INPUT", `${path} is not valid JSON`, [{ ruleId: "cli.file_json", field: "file" }]);
  }
}

function usageError(message: string): DomainError {
  return new DomainError("INVALID_INPUT", `${message}。${USAGE}`, [{ ruleId: "cli.usage" }]);
}
