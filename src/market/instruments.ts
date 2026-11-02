import { isDecimalString } from "../lib/decimal.ts";
import { msToIso } from "../lib/time.ts";

export type ProductType = "spot" | "usdt_perpetual";

export const OKX_INST_TYPE: Record<ProductType, "SPOT" | "SWAP"> = { spot: "SPOT", usdt_perpetual: "SWAP" };

/** The subset of OKX GET /api/v5/public/instruments fields this project reads. */
export interface OkxInstrumentRow {
  instId: string;
  instType: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  ctType: string;
  ctVal: string;
  ctValCcy: string;
  state: string;
  listTime: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
}

export interface Instrument {
  instId: string;
  product: ProductType;
  /** spot: baseCcy; perpetual: ctValCcy (the coin one contract is denominated in). */
  baseCcy: string;
  /** spot: quote currency; perpetual: settlement currency. */
  quoteCcy: "USDT";
  state: string;
  /** ISO 8601; null when OKX leaves it empty. */
  listTime: string | null;
  tickSz: string;
  /** spot: base-currency step; perpetual: contract step. */
  lotSz: string;
  /** spot: base currency; perpetual: contracts. */
  minSz: string;
  /** perpetual only: base currency per contract. */
  ctVal: string | null;
}

export function parseInstruments(rows: OkxInstrumentRow[]): Instrument[] {
  const instruments: Instrument[] = [];
  for (const row of rows) {
    const common = {
      instId: row.instId,
      quoteCcy: "USDT" as const,
      state: row.state,
      listTime: msToIso(row.listTime),
      tickSz: row.tickSz,
      lotSz: row.lotSz,
      minSz: row.minSz,
    };
    if (row.instType === "SPOT" && row.quoteCcy === "USDT") {
      instruments.push({ ...common, product: "spot", baseCcy: row.baseCcy, ctVal: null });
    } else if (row.instType === "SWAP" && row.settleCcy === "USDT" && row.ctType === "linear" && isDecimalString(row.ctVal)) {
      instruments.push({ ...common, product: "usdt_perpetual", baseCcy: row.ctValCcy, ctVal: row.ctVal });
    }
  }
  return instruments;
}
