import { z } from "zod";
import { DomainError } from "../lib/errors.ts";

export const TRADE_KIT_VERSION = "1.5.0";
export type DemoSite = "global" | "eea" | "us" | "tr";
export interface DemoScope { scopeId: string; site: DemoSite; environment: "demo" }

/** Internal transport port. Never registered as a general Agent tool. */
export interface TradeKitPeer {
  getServerVersion(): { name: string; version: string } | undefined;
  listTools(): Promise<unknown>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

const row = z.record(z.string(), z.unknown());
const capabilities = z.object({ readOnly: z.literal(true), demo: z.literal(true), hasAuth: z.literal(true) });
const payload = z.object({ tool: z.string(), ok: z.literal(true), data: z.unknown(), capabilities });
const result = z.object({ endpoint: z.string(), requestTime: z.iso.datetime({ offset: true }), data: z.array(row) });

const TOOLS = {
  config: { tool: "account_get_config", endpoint: "GET /api/v5/account/config" },
  balance: { tool: "account_get_balance", endpoint: "GET /api/v5/account/balance" },
  positions: { tool: "account_get_positions", endpoint: "GET /api/v5/account/positions" },
  spotOrders: { tool: "spot_get_orders", endpoint: "GET /api/v5/trade/orders-pending" },
  perpetualOrders: { tool: "swap_get_orders", endpoint: "GET /api/v5/trade/orders-pending" },
  spotProtection: { tool: "spot_get_algo_orders", endpoint: "GET /api/v5/trade/orders-algo-pending" },
  perpetualProtection: { tool: "swap_get_algo_orders", endpoint: "GET /api/v5/trade/orders-algo-pending" },
} as const;

export interface PrivateReadPage { endpoint: string; requestTime: string; rows: Record<string, unknown>[] }
export type DemoReadPart = { status: "ok"; pages: PrivateReadPage[] } | { status: "unavailable"; reason: "read_failed_or_incomplete" };
export interface DemoReadSnapshot {
  scope: DemoScope;
  parts: Record<keyof typeof TOOLS, DemoReadPart>;
  accountReadComplete: boolean;
  reconciled: false;
  executionAuthorized: false;
  missing: readonly ["capital_history", "managed_ownership", "auto_add_margin_verification"];
}

function unavailable(ruleId: string): never {
  throw new DomainError("DEPENDENCY_UNAVAILABLE", "Trade Kit demo read is unavailable or incomplete", [{ ruleId }]);
}

/** Validate the actual server before allowing any private read. No write method is returned. */
export async function createDemoReadSession(peer: TradeKitPeer, scope: DemoScope) {
  if (!scope.scopeId.trim() || scope.environment !== "demo" || !["global", "eea", "us", "tr"].includes(scope.site)) unavailable("tradekit.demo_scope");
  const server = peer.getServerVersion();
  if (server?.name !== "okx-trade-mcp" || server.version !== TRADE_KIT_VERSION) unavailable("tradekit.version_pinned");
  let toolList: unknown;
  try { toolList = await peer.listTools(); } catch { unavailable("tradekit.tool_list"); }
  const listed = z.object({ tools: z.array(z.object({ name: z.string(), annotations: z.object({ readOnlyHint: z.literal(true) }) })) }).safeParse(toolList);
  if (!listed.success) unavailable("tradekit.read_only_toolset");
  const names = new Set(listed.data.tools.map((tool) => tool.name));
  if (!["system_get_capabilities", ...Object.values(TOOLS).map((tool) => tool.tool)].every((name) => names.has(name))) unavailable("tradekit.required_reads");
  const system = await readPayload(peer, "system_get_capabilities", {});
  const advertised = z.object({ server: z.object({ name: z.literal("okx-trade-mcp"), version: z.literal(TRADE_KIT_VERSION) }), capabilities }).safeParse(system);
  if (!advertised.success) unavailable("tradekit.demo_capabilities");

  async function read(kind: keyof typeof TOOLS, args: Record<string, unknown>): Promise<PrivateReadPage> {
    const spec = TOOLS[kind];
    const parsed = result.safeParse(await readPayload(peer, spec.tool, args));
    if (!parsed.success || parsed.data.endpoint !== spec.endpoint) unavailable("tradekit.read_response");
    return { endpoint: parsed.data.endpoint, requestTime: parsed.data.requestTime, rows: parsed.data.data };
  }

  async function paged(kind: keyof typeof TOOLS, args: Record<string, unknown>, idField: "ordId" | "algoId"): Promise<PrivateReadPage[]> {
    const pages: PrivateReadPage[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await read(kind, { ...args, limit: 100, ...(after ? { after } : {}) });
      if (data.rows.length > 100) unavailable("tradekit.pagination_page_size");
      for (const item of data.rows) {
        const id = item[idField];
        if (typeof id !== "string" || !id || seen.has(id)) unavailable("tradekit.pagination_identity");
        seen.add(id);
      }
      pages.push(data);
      if (data.rows.length < 100) return pages;
      after = data.rows.at(-1)![idField] as string;
    }
    unavailable("tradekit.pagination_limit");
  }

  return {
    /** Private rows remain inside the backend. These reads do not establish ownership or a reconciled ledger. */
    async refresh(): Promise<DemoReadSnapshot> {
      const reads: Record<keyof typeof TOOLS, () => Promise<PrivateReadPage[]>> = {
        config: async () => {
          const page = await read("config", {});
          if (page.rows.length !== 1) unavailable("tradekit.account_config_present");
          return [page];
        },
        balance: async () => {
          const page = await read("balance", {});
          if (page.rows.length !== 1) unavailable("tradekit.account_balance_present");
          return [page];
        },
        positions: async () => [await read("positions", { instType: "SWAP" })],
        spotOrders: () => paged("spotOrders", { status: "open" }, "ordId"),
        perpetualOrders: () => paged("perpetualOrders", { status: "open", instType: "SWAP" }, "ordId"),
        spotProtection: async () => (await Promise.all(["conditional", "oco", "move_order_stop"].map((ordType) => paged("spotProtection", { status: "pending", ordType }, "algoId")))).flat(),
        perpetualProtection: async () => (await Promise.all(["conditional", "oco", "move_order_stop"].map((ordType) => paged("perpetualProtection", { status: "pending", instType: "SWAP", ordType }, "algoId")))).flat(),
      };
      const entries = await Promise.all(Object.entries(reads).map(async ([name, load]) => {
        try { return [name, { status: "ok", pages: await load() } satisfies DemoReadPart] as const; }
        catch { return [name, { status: "unavailable", reason: "read_failed_or_incomplete" } satisfies DemoReadPart] as const; }
      }));
      const parts = Object.fromEntries(entries) as DemoReadSnapshot["parts"];
      return { scope: { ...scope }, parts, accountReadComplete: Object.values(parts).every((part) => part.status === "ok"), reconciled: false, executionAuthorized: false,
        missing: ["capital_history", "managed_ownership", "auto_add_margin_verification"] };
    },
  };
}

async function readPayload(peer: TradeKitPeer, name: string, args: Record<string, unknown>): Promise<unknown> {
  let raw: unknown;
  try { raw = await peer.callTool({ name, arguments: args }); }
  catch { unavailable("tradekit.transport"); }
  const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional() }).safeParse(raw);
  if (!envelope.success || envelope.data.isError) unavailable("tradekit.read_error");
  const parsed = payload.safeParse(envelope.data.structuredContent);
  if (!parsed.success || parsed.data.tool !== name) unavailable("tradekit.response_scope");
  return parsed.data.data;
}
