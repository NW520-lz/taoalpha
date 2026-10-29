import { parseArgs } from "node:util";
import { DomainError } from "./lib/errors.ts";
import { DEMO_ACCOUNT_GAPS, normalizeDemoAccount } from "./account/demo-account.ts";
import type { AccountValidation } from "./account/demo-account.ts";
import { connectTradeKitDemoReader } from "./okx/trade-kit-transport.ts";
import type { DemoReadSnapshot, DemoSite } from "./okx/trade-kit-demo-reader.ts";

type Reader = { refresh(): Promise<DemoReadSnapshot>; close(): Promise<void> };
type Connect = (input: { scopeId: string; profile: string; site: DemoSite }) => Promise<Reader>;
const SAFE_CONNECTION_RULES = new Set([
  "tradekit.profile_scope", "tradekit.profile_parse", "tradekit.profile_present", "tradekit.demo_profile",
  "tradekit.official_origin", "tradekit.profile_size", "tradekit.profile_readable", "tradekit.package_pinned",
  "tradekit.isolated_home", "tradekit.session_verified",
]);

/** Read-only connectivity and semantic diagnostic; return only fixed checks and counts. */
export async function runDemoCheck(argv: string[], connect: Connect = connectTradeKitDemoReader, now?: Date) {
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
    const normalized = normalizeDemoAccount(snapshot, now ?? new Date());
    return {
      ok: normalized.ok,
      connectivityOk: normalized.readsComplete,
      environment: "demo" as const,
      site: values.site,
      executionAuthorized: false as const,
      reconciled: false as const,
      blockNewRisk: true as const,
      accountValidation: normalized.validation,
      reads: normalized.validation.parts.map(({ part }) => {
        const result = snapshot.parts?.[part];
        return result?.status === "ok"
          ? { part, status: "ok", pages: Array.isArray(result.pages) ? result.pages.length : null, rows: normalized.observedRows[part] }
          : { part, status: "unavailable", reason: "read_failed_or_incomplete" };
      }),
      missing: [...DEMO_ACCOUNT_GAPS],
      summaryZh: normalized.ok ? "Demo 只读查询和字段校验完成；资金流、受管归属、自动追加、合约估值、保护覆盖及风控配置仍待核对，不能下单。" : normalized.readsComplete ? "Demo 只读连接成功，但账户字段或来源时间校验失败；不能下单。" : "部分 Demo 只读查询失败或不完整；不能下单，请检查配置与站点能力。",
    };
  } catch (error) {
    return {
      ok: false,
      connectivityOk: false,
      environment: "demo" as const,
      executionAuthorized: false as const,
      reconciled: false as const,
      blockNewRisk: true as const,
      accountValidation: { status: "failed", parts: [], checks: ["account.check_unavailable"], gaps: [...DEMO_ACCOUNT_GAPS] } satisfies AccountValidation,
      missing: [...DEMO_ACCOUNT_GAPS],
      error: { code: error instanceof DomainError ? error.code : "DEPENDENCY_UNAVAILABLE", rules: error instanceof DomainError ? error.violations.map((violation) => violation.ruleId).filter((rule) => SAFE_CONNECTION_RULES.has(rule)) : [] },
      summaryZh: "Demo 检查未完成。请在本机配置专用 demo profile，并使用 --profile <name> --site <global|eea|us|tr>；不要把凭证发到聊天或提交 Git。",
    };
  } finally {
    try { await reader?.close(); } catch { /* Closing cannot disclose upstream diagnostics. */ }
  }
}
