import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runCli, type CliDeps, type Envelope } from "../cli.ts";
import { DomainError, type ErrorCode } from "../lib/errors.ts";
import { createMethodRecord, getMethodRecord, getMethodContext, methodContextSchema, methodRecordSchema } from "../research/method-record.ts";
import { completeTask, startResearch, getRun } from "../research/research-service.ts";
import type { ScanContent } from "../scan/scan.ts";
import type { PublicError } from "../okx/public-client.ts";

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: "研究请求不符合输入或证据约束。",
  DATA_NOT_READY: "研究数据尚未就绪。",
  IDEMPOTENCY_CONFLICT: "该研究任务已提交不同内容。",
  UNSUPPORTED_CAPABILITY: "不支持该研究操作。",
  DEPENDENCY_UNAVAILABLE: "研究服务暂时不可用。",
  PERSISTENCE_UNAVAILABLE: "研究存储暂时不可用。",
};
const SAFE_RULES = new Set([
  "bundle.exists", "evidence.exists", "research.agent_mode", "research.bundle_exists", "research.assignment_exists",
  "research.assignment_once", "research.failure_reason", "research.source_key_unique", "research.evidence_ref_known",
  "research.objection_target_known", "research.candidate_in_bundle", "research.objection_answered", "research.objection_known",
  "research.run_exists", "research.conflict_schema", "research.conflict_hash", "research.bundle_hash", "research.candidate_scope", "research.decision_hash", "research.decision_missing",
  "research.method_context_missing", "research.method_duplicate", "research.method_hash", "research.method_prior",
  "research.method_record_missing", "research.method_refs", "research.method_schema", "research.method_scope",
  "strategy.readable", "strategy.json",
  ...["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"]
    .flatMap((code) => [`schema.${code}`, `strategy.${code}`]),
]);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));

function result(envelope: Envelope): CallToolResult {
  if (envelope.ok && (envelope.operation === "scan" || envelope.operation === "bundle")) {
    const content = envelope.value as ScanContent;
    envelope = { ...envelope, value: { ...content,
      sourceErrors: content.sourceErrors.map(({ endpoint, error }) => ({ endpoint, error: safeSourceError(error) })) } };
  }
  return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: { ...envelope }, isError: !envelope.ok };
}

function safeSourceError(error: PublicError): PublicError {
  switch (error.kind) {
    case "network": case "parse": return { kind: error.kind, message: "Public source unavailable." };
    case "http": return { kind: "http", status: error.status };
    case "okx": return { kind: "okx", code: /^\d{1,10}$/.test(error.code) ? error.code : "UNKNOWN", msg: "Public source rejected request." };
  }
}

/** Borrows backend dependencies; their owner closes the database after the server. No account or execution tools. */
export function createResearchMcpServer(deps: CliDeps): McpServer {
  const server = new McpServer({ name: "taoalpha-research", version: "0.1.0" });
  const handlers = new Map<string, (input: unknown) => Promise<CallToolResult>>();

  function failure(operation: string, error?: Envelope["error"], rule?: string): CallToolResult {
    const code = error && Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : "DEPENDENCY_UNAVAILABLE";
    let asOf: string;
    try { asOf = deps.now().toISOString(); } catch { asOf = new Date().toISOString(); }
    const violations = rule ? [{ ruleId: rule }] : (error?.violations ?? [])
      .filter((violation) => SAFE_RULES.has(violation.ruleId)).map(({ ruleId }) => ({ ruleId }));
    return result({ ok: false, operation, mode: "M0_readonly_research", asOf,
      error: { code, message: ERROR_MESSAGES[code], violations }, summaryZh: `失败（${code}）：${ERROR_MESSAGES[code]}` });
  }

  function add<S extends z.ZodRawShape>(name: string, operation: string, description: string, schema: z.ZodObject<S>, localWrite: boolean,
    run: (input: z.output<z.ZodObject<S>>) => Promise<Envelope>) {
    const invoke = async (input: unknown): Promise<CallToolResult> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return failure(operation, { code: "INVALID_INPUT", message: "", violations: [] }, "mcp.input_schema");
      try {
        const envelope = await run(parsed.data);
        return envelope.ok ? result(envelope) : failure(operation, envelope.error);
      } catch (error) {
        return failure(operation, error instanceof DomainError ? { code: error.code, message: "", violations: error.violations } : undefined);
      }
    };
    handlers.set(name, invoke);
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: !localWrite, destructiveHint: false, openWorldHint: true } }, invoke);
  }

  add("taoalpha_status", "status", "查看研究状态；不读取账户，不发市场请求。", z.object({}).strict(), false,
    () => runCli(["status"], deps));
  add("taoalpha_scan", "scan", "读取公开行情并冻结本地研究证据；策略由后端配置，无交易写入。", z.object({}).strict(), true,
    () => runCli(["scan"], deps));
  add("taoalpha_bundle", "bundle", "按引用读取冻结证据包及快照。", z.object({ bundleId: id("bundle"), top: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict(), false,
    ({ bundleId, top }) => runCli(["bundle", bundleId, ...(top === undefined ? [] : ["--top", String(top)])], deps));
  add("taoalpha_evidence", "evidence", "按引用读取研究证据。", z.object({ evidenceId: id("ev") }).strict(), false,
    ({ evidenceId }) => runCli(["evidence", evidenceId], deps));
  add("taoalpha_research_start", "research start", "创建本地三阶段研究任务；宿主运行方式自报且未核验。",
    z.object({ bundleId: id("bundle"), agentMode: z.enum(["parallel_independent", "serial_degraded"]), methodContext:methodContextSchema.optional() }).strict(), true,
    async (input) => { const view=startResearch(deps.db,input,deps.now); return {...await runCli(["research","get",view.runId],deps),operation:"research start"}; });
  add("taoalpha_research_conflicts", "research conflicts", "查询已关闭阶段的冲突提交指纹；无报告正文或超时判断。", z.object({runId:id("run")}).strict(), false,
    ({runId}) => runCli(["research","conflicts",runId],deps));
  add("taoalpha_research_tasks", "research tasks", "拉取当前阶段的角色任务；不启动宿主 Agent。", z.object({ runId: id("run") }).strict(), false,
    ({ runId }) => runCli(["research", "tasks", runId], deps));
  add("taoalpha_research_submit", "research submit", "提交结构化报告或失败原因；只写本地研究记录，不读取请求文件。",
    z.object({ assignmentId: id("asg"), outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("report"), report: z.unknown() }).strict(),
      z.object({ kind: z.literal("failed"), reason: z.string().trim().min(1) }).strict(),
    ]) }).strict(), true, async (input) => {
      const view = completeTask(deps.db, input, deps.now);
      return { ...await runCli(["research", "get", view.runId], deps), operation: "research submit" };
    });
  add("taoalpha_research_get", "research get", "读取研究结论、来源和不可执行草稿；不构成交易授权。", z.object({ runId: id("run") }).strict(), false,
    ({ runId }) => runCli(["research", "get", runId], deps));

  add("taoalpha_method_create", "research method-create", "追加本地方法记录；无交易所写入，论断未核验。", methodRecordSchema, true,
    async input => ({ok:true, operation:"research method-create",mode:"M0_readonly_research", asOf:deps.now().toISOString(),value:createMethodRecord(deps.db,input,deps.now),summaryZh:"本地方法记录已追加；不可执行。"}));
  add("taoalpha_method_get", "research method-get", "读取本地方法记录。", z.object({recordId:id("method")}).strict(), false,
    async ({recordId}) => ({ok:true,operation:"research method-get",mode:"M0_readonly_research",asOf:deps.now().toISOString(),value:getMethodRecord(deps.db,recordId),summaryZh:"方法记录未核验。"}));
  add("taoalpha_method_context", "research method-context", "读取冻结方法上下文。", z.object({runId:id("run")}).strict(), false,
    async ({runId}) => {getRun(deps.db,runId); return {ok:true,operation:"research method-context",mode:"M0_readonly_research",asOf:deps.now().toISOString(),value:getMethodContext(deps.db,runId),summaryZh:"冻结方法上下文。"};});

  // The SDK's default validation errors contain raw input diagnostics and lack structuredContent.
  // Its documented underlying server supports a handler that enforces the same published schemas safely.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const invoke = handlers.get(request.params.name);
    if (!invoke) return failure("(unknown)", { code: "INVALID_INPUT", message: "", violations: [] }, "mcp.tool_known");
    return invoke(request.params.arguments ?? {});
  });
  return server;
}
