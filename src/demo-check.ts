import { parseArgs } from "node:util";
import { DomainError } from "./lib/errors.ts";
import { connectTradeKitDemoReader } from "./okx/trade-kit-transport.ts";
import type { DemoReadSnapshot, DemoSite } from "./okx/trade-kit-demo-reader.ts";

type Reader = { refresh(): Promise<DemoReadSnapshot>; close(): Promise<void> };
type Connect = (input: { scopeId: string; profile: string; site: DemoSite }) => Promise<Reader>;

/** Connectivity diagnostic only. Return counts/statuses, never account records or credentials. */
export async function runDemoCheck(argv: string[], connect: Connect = connectTradeKitDemoReader) {
  let reader: Reader | undefined;
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args: argv, options: { profile: { type: "string" }, site: { type: "string" } }, allowPositionals: true, strict: true }); }
    catch { throw new DomainError("INVALID_INPUT", "invalid demo:check arguments"); }
    const { values, positionals } = parsed;
    if (positionals.length || typeof values.profile !== "string" || typeof values.site !== "string" || !["global", "eea", "us", "tr"].includes(values.site)) {
      throw new DomainError("INVALID_INPUT", "demo:check requires --profile <name> --site <global|eea|us|tr>");
    }
    reader = await connect({ scopeId: "local-demo-connectivity-check", profile: values.profile, site: values.site as DemoSite });
    const snapshot = await reader.refresh();
    if (snapshot.scope.environment !== "demo" || snapshot.scope.site !== values.site) throw new DomainError("DEPENDENCY_UNAVAILABLE", "demo scope mismatch");
    return {
      ok: snapshot.accountReadComplete,
      environment: "demo" as const,
      site: values.site,
      executionAuthorized: false as const,
      reconciled: false as const,
      reads: Object.entries(snapshot.parts).map(([part, result]) => result.status === "ok"
        ? { part, status: "ok", pages: result.pages.length, rows: result.pages.reduce((n, page) => n + page.rows.length, 0) }
        : { part, status: "unavailable", reason: result.reason }),
      missing: snapshot.missing,
      summaryZh: snapshot.accountReadComplete ? "Demo 只读查询完成；资金流、仓位归属和自动追加状态仍待核对，不能下单。" : "部分 Demo 只读查询失败或不完整；不能下单，请检查配置与站点能力。",
    };
  } catch (error) {
    return {
      ok: false,
      environment: "demo" as const,
      executionAuthorized: false as const,
      reconciled: false as const,
      error: { code: error instanceof DomainError ? error.code : "DEPENDENCY_UNAVAILABLE", rules: error instanceof DomainError ? error.violations.map((v) => v.ruleId) : [] },
      summaryZh: "Demo 检查未完成。请在本机配置专用 demo profile，并使用 --profile <name> --site <global|eea|us|tr>；不要把凭证发到聊天或提交 Git。",
    };
  } finally {
    await reader?.close().catch(() => {});
  }
}
