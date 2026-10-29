import { z } from "zod";
import type { DemoReadSnapshot } from "../okx/trade-kit-demo-reader.ts";

const ENDPOINTS = {
  config: "GET /api/v5/account/config", balance: "GET /api/v5/account/balance", positions: "GET /api/v5/account/positions",
  spotOrders: "GET /api/v5/trade/orders-pending", perpetualOrders: "GET /api/v5/trade/orders-pending",
  spotProtection: "GET /api/v5/trade/orders-algo-pending", perpetualProtection: "GET /api/v5/trade/orders-algo-pending",
} as const;
type Part = keyof typeof ENDPOINTS;
export const DEMO_ACCOUNT_GAPS = ["capital_history", "managed_ownership", "auto_add_margin_verification", "contract_metadata_valuation", "protected_coverage", "approved_risk_config"] as const;
export interface AccountValidation {
  status: "ok" | "failed";
  parts: { part: Part; status: "ok" | "failed" | "unavailable"; checks: string[]; gaps: string[] }[];
  checks: string[];
  gaps: string[];
}
export interface DemoAccount {
  config: { uid: string; accountLevel: "1" | "2" | "3" | "4"; positionMode: "net_mode" | "long_short_mode" };
  equity: { total: { amount: string; unit: "USD" }; updatedAtMs: string; assets: { currency: string; equity: { amount: string; unit: "coin" } }[] };
  positions: { positionId: string; instrumentId: string; instrumentType: "SWAP"; marginMode: "isolated" | "cross"; positionSide: "net" | "long" | "short"; contracts: string; quantityUnit: "contracts"; marginCurrency: "USDT"; updatedAtMs: string }[];
}
interface BaseResult {
  readsComplete: boolean;
  validation: AccountValidation;
  observedRows: Record<Part, number | null>;
  executionAuthorized: false;
  reconciled: false;
  blockNewRisk: true;
}
export type DemoAccountResult = BaseResult & ({ ok: true; account: DemoAccount } | { ok: false });
const nonempty = z.string().refine((value) => value.trim().length > 0);
const configSchema = z.object({ uid: nonempty, acctLv: z.enum(["1", "2", "3", "4"]), posMode: z.enum(["net_mode", "long_short_mode"]) });
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const timestamp = z.string().regex(/^\d+$/).refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0);
const balanceSchema = z.object({ totalEq: decimal, uTime: timestamp, details: z.array(z.object({ ccy: nonempty, eq: decimal })) });
const positionSchema = z.object({ posId: nonempty, instId: nonempty, instType: z.literal("SWAP"), mgnMode: z.enum(["isolated", "cross"]), posSide: z.enum(["net", "long", "short"]), pos: decimal, uTime: timestamp,
  ccy: z.string().optional(), settleCcy: z.string().optional(), ctType: z.string().optional() });
const pagesSchema = z.array(z.object({ endpoint: z.string(), requestTime: z.unknown(), rows: z.array(z.record(z.string(), z.unknown())) })).min(1);
const observationTime = z.iso.datetime({ offset: true });

/** Backend-only projection. requestTime is local observation time; reads are not atomic.
 * Exchange uTime is last update, so unchanged data may have old uTime.
 * Never return the successful private account object through CLI/MCP.
 */
export function normalizeDemoAccount(snapshot: DemoReadSnapshot, now: Date): DemoAccountResult {
  const observedRows = {} as Record<Part, number | null>;
  const parts: AccountValidation["parts"] = [];
  const collected = {} as Record<Part, Record<string, unknown>[]>;
  const checks: string[] = [];
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs) || nowMs <= 0) checks.push("account.validation_clock");
  if (snapshot.scope?.environment !== "demo" || !["global", "eea", "us", "tr"].includes(snapshot.scope?.site)) checks.push("account.demo_scope");
  let readsComplete = snapshot.accountReadComplete === true;
  if (!readsComplete) checks.push("account.reads_complete");
  for (const part of Object.keys(ENDPOINTS) as Part[]) {
    const source = snapshot.parts?.[part];
    const validation: AccountValidation["parts"][number] = { part, status: "ok", checks: [], gaps: [] };
    parts.push(validation);
    observedRows[part] = null;
    collected[part] = [];
    if (source?.status !== "ok") {
      validation.status = "unavailable";
      validation.checks.push("account.read_present");
      readsComplete = false;
      continue;
    }
    const pages = pagesSchema.safeParse(source.pages);
    // Count observed rows even when endpoint/time provenance is rejected.
    if (Array.isArray(source.pages) && source.pages.length > 0 && source.pages.every((page) => page && Array.isArray(page.rows))) {
      observedRows[part] = source.pages.reduce((sum, page) => sum + page.rows.length, 0);
    }
    if (!pages.success) {
      validation.status = "failed";
      validation.checks.push("account.read_pages");
      readsComplete = false;
      continue;
    }
    collected[part] = pages.data.flatMap((page) => page.rows);
    if (pages.data.some((page) => page.endpoint !== ENDPOINTS[part])) validation.checks.push("account.read_endpoint");
    if (pages.data.some((page) => !observationTime.safeParse(page.requestTime).success ||
      !Number.isFinite(Date.parse(page.requestTime as string)) || !Number.isFinite(nowMs) || nowMs <= 0 ||
      nowMs - Date.parse(page.requestTime as string) > 30000 || Date.parse(page.requestTime as string) - nowMs > 5000)) validation.checks.push("account.observation_time");
    if (validation.checks.length) validation.status = "failed";
  }
  const configRows = collected.config;
  const parsedConfig = configSchema.safeParse(configRows[0]);
  if (parts[0]!.status === "ok" && (configRows.length !== 1 || !parsedConfig.success)) {
    parts[0]!.status = "failed";
    parts[0]!.checks.push("account.config_schema");
  }
  const balanceRows = collected.balance;
  const parsedBalance = balanceSchema.safeParse(balanceRows[0]);
  if (parts[1]!.status === "ok" && (balanceRows.length !== 1 || !parsedBalance.success || Number(parsedBalance.data.uTime) > nowMs + 5000 || new Set(parsedBalance.data.details.map((asset) => asset.ccy)).size !== parsedBalance.data.details.length)) {
    parts[1]!.status = "failed";
    parts[1]!.checks.push("account.balance_schema");
  }
  const normalizedPositions: DemoAccount["positions"] = [];
  const seenPositions = new Set<string>();
  for (const raw of collected.positions) {
    const parsed = positionSchema.safeParse(raw);
    if (!parsed.success || Number(parsed.data.uTime) > nowMs + 5000 ||
      (parsed.data.posSide !== "net" && parsed.data.pos.startsWith("-") && !/^-0+(?:\.0+)?$/.test(parsed.data.pos)) || seenPositions.has(parsed.data.posId)) {
      parts[2]!.status = "failed";
      if (!parts[2]!.checks.includes("account.positions_schema")) parts[2]!.checks.push("account.positions_schema");
      continue;
    }
    const p = parsed.data;
    seenPositions.add(p.posId);
    if (!/^[A-Z0-9]+-USDT-SWAP$/.test(p.instId) || p.ccy !== "USDT" || (p.settleCcy !== undefined && p.settleCcy !== "" && p.settleCcy !== "USDT") || (p.ctType !== undefined && p.ctType !== "" && p.ctType !== "linear")) {
      parts[2]!.status = "failed";
      if (!parts[2]!.gaps.includes("unsupported_product")) parts[2]!.gaps.push("unsupported_product");
      continue;
    }
    normalizedPositions.push({ positionId: p.posId, instrumentId: p.instId, instrumentType: "SWAP", marginMode: p.mgnMode, positionSide: p.posSide, contracts: p.pos, quantityUnit: "contracts", marginCurrency: "USDT", updatedAtMs: p.uTime });
  }
  const ok = readsComplete && checks.length === 0 && parts.every((part) => part.status === "ok");
  const base: BaseResult = { readsComplete, validation: { status: ok ? "ok" : "failed", parts, checks, gaps: [...DEMO_ACCOUNT_GAPS] }, observedRows, executionAuthorized: false, reconciled: false, blockNewRisk: true };
  if (!ok || !parsedConfig.success || !parsedBalance.success) return { ...base, ok: false };
  const c = parsedConfig.data;
  const b = parsedBalance.data;
  const account: DemoAccount = {
    config: { uid: c.uid, accountLevel: c.acctLv, positionMode: c.posMode },
    equity: { total: { amount: b.totalEq, unit: "USD" }, updatedAtMs: b.uTime,
      assets: b.details.map((asset) => ({ currency: asset.ccy, equity: { amount: asset.eq, unit: "coin" } })) },
    positions: normalizedPositions,
  };
  return { ...base, ok: true, account };
}
