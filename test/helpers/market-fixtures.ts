import type { OkxInstrumentRow } from "../../src/market/instruments.ts";
import type { OkxBookRow, OkxTickerRow } from "../../src/market/snapshot.ts";
import { parseStrategy, type LoadedStrategy, type StrategyDefinition } from "../../src/scan/strategy.ts";
import type { Route } from "./fake-okx.ts";

// Synthetic market: GOOD passes screening, WIDE fails on spread, DEAD is not live.
export const NOW = new Date("2026-10-28T12:00:00.000Z");
export const FRESH_TS = "1793188799000"; // NOW - 1 s
const LISTED_2025 = "1735689600000"; // 2025-01-01, 665 days before NOW

function instrumentRow(o: Partial<OkxInstrumentRow> & Pick<OkxInstrumentRow, "instId" | "instType">): OkxInstrumentRow {
  return { baseCcy: "", quoteCcy: "", settleCcy: "", ctType: "", ctVal: "", ctValCcy: "", state: "live", listTime: LISTED_2025, tickSz: "0.001", lotSz: "0.0001", minSz: "0.0001", ...o };
}

function tickerRow(instId: string, o: Partial<OkxTickerRow> = {}): OkxTickerRow {
  return { instId, last: "10", bidPx: "9.999", askPx: "10.001", open24h: "9", high24h: "10.5", low24h: "8.9", vol24h: "0", volCcy24h: "10000000", ts: FRESH_TS, ...o };
}

function bookRow(px: string, sz: string): OkxBookRow {
  return { asks: [[px, sz, "0", "1"]], bids: [[px, sz, "0", "1"]], ts: FRESH_TS };
}

export function marketRoutes(): Record<string, Route> {
  return {
    "/api/v5/public/instruments?instType=SPOT": {
      rows: [
        instrumentRow({ instId: "GOOD-USDT", instType: "SPOT", baseCcy: "GOOD", quoteCcy: "USDT" }),
        instrumentRow({ instId: "WIDE-USDT", instType: "SPOT", baseCcy: "WIDE", quoteCcy: "USDT" }),
        instrumentRow({ instId: "DEAD-USDT", instType: "SPOT", baseCcy: "DEAD", quoteCcy: "USDT", state: "suspend" }),
      ],
    },
    "/api/v5/market/tickers?instType=SPOT": {
      rows: [
        tickerRow("GOOD-USDT"),
        tickerRow("WIDE-USDT", { last: "1", bidPx: "0.9", askPx: "1.1", open24h: "1.25", high24h: "1.3", low24h: "0.95", volCcy24h: "6000000" }),
        tickerRow("DEAD-USDT", { volCcy24h: "99000000" }),
      ],
    },
    "/api/v5/market/books?instId=GOOD-USDT&sz=5": { rows: [bookRow("10", "5000")] },
    "/api/v5/market/books?instId=WIDE-USDT&sz=5": { rows: [bookRow("1", "50000")] },
    "/api/v5/public/instruments?instType=SWAP": {
      rows: [instrumentRow({ instId: "GOOD-USDT-SWAP", instType: "SWAP", settleCcy: "USDT", ctType: "linear", ctVal: "1", ctValCcy: "GOOD" })],
    },
    "/api/v5/market/tickers?instType=SWAP": { rows: [tickerRow("GOOD-USDT-SWAP", { volCcy24h: "1000000" })] },
    "/api/v5/market/books?instId=GOOD-USDT-SWAP&sz=5": { rows: [bookRow("10", "3000")] },
    "/api/v5/public/funding-rate?instId=ANY": {
      rows: [{ instId: "GOOD-USDT-SWAP", fundingRate: "0.0001", fundingTime: "1793203200000", nextFundingTime: "1793232000000", ts: FRESH_TS }],
    },
    "/api/v5/public/open-interest?instType=SWAP": { rows: [{ instId: "GOOD-USDT-SWAP", oi: "50000", oiCcy: "50000", oiUsd: "500000", ts: FRESH_TS }] },
    "/api/v5/public/mark-price?instType=SWAP": { rows: [{ instId: "GOOD-USDT-SWAP", markPx: "10", ts: FRESH_TS }] },
    "/api/v5/market/index-tickers?quoteCcy=USDT": { rows: [{ instId: "GOOD-USDT", idxPx: "10", ts: FRESH_TS }] },
  };
}

export function testStrategy(overrides: Partial<StrategyDefinition> = {}): LoadedStrategy {
  return parseStrategy(
    {
      id: "test-flow",
      version: 1,
      description: "test strategy",
      validation: { state: "unvalidated" },
      products: ["spot", "usdt_perpetual"],
      shortlistPerProduct: 10,
      depthLevels: 5,
      screening: { minTurnover24hUsdt: "5000000", maxSpreadBps: "10", minDepthUsdtPerSide: "20000", minListingDays: 30, maxDataAgeMs: 120000 },
      ...overrides,
    },
    "test",
  );
}
