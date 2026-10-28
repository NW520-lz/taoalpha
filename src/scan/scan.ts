import { Decimal, dec } from "../lib/decimal.ts";
import type { OkxSite, PublicClient, PublicError } from "../okx/public-client.ts";
import { OKX_INST_TYPE, parseInstruments, type Instrument, type OkxInstrumentRow, type ProductType } from "../market/instruments.ts";
import {
  buildSnapshot,
  tickerFields,
  type MarketSnapshot,
  type OkxBookRow,
  type OkxFundingRow,
  type OkxIndexTickerRow,
  type OkxMarkPriceRow,
  type OkxOpenInterestRow,
  type OkxTickerRow,
  type SnapshotSources,
  type Sourced,
  type TickerFields,
} from "../market/snapshot.ts";
import type { Db } from "../store/db.ts";
import { saveBundle, saveEvidence, saveRaw } from "../store/evidence-store.ts";
import { appendAudit } from "../store/audit.ts";
import type { LoadedStrategy, Screening } from "./strategy.ts";

export type ScreenRule = "turnover_24h" | "spread" | "depth_per_side" | "listing_age" | "data_complete" | "data_fresh";

export interface ScreenCheck {
  rule: ScreenRule;
  pass: boolean;
  actual: string | null;
  threshold: string;
}

export interface ScanCandidate {
  instId: string;
  product: ProductType;
  snapshotEvidenceId: string;
  turnover24hUsdt: string | null;
  change24hPct: string | null;
  spreadBps: string | null;
  screening: { state: "not_configured" } | { state: "applied"; passed: boolean; checks: ScreenCheck[] };
}

export interface ProductScanStatus {
  product: ProductType;
  status: "ok" | "unavailable";
  liveInstruments: number;
  /** Live instruments dropped because their ticker was absent or unusable. */
  missingTicker: number;
  shortlisted: number;
}

/** Frozen bundle content. Rankings are research input, never trade instructions. */
export interface ScanContent {
  createdAt: string;
  site: OkxSite;
  strategy: { id: string; version: number; contentHash: string; validation: "unvalidated" };
  screening: "applied" | "not_configured";
  products: ProductScanStatus[];
  sourceErrors: Array<{ endpoint: string; error: PublicError }>;
  candidates: ScanCandidate[];
}

export interface ScanResult extends ScanContent {
  bundleId: string;
  bundleSha256: string;
}

interface Fetched<T> {
  rows: T[];
  rawRef: string;
  receivedAt: string;
}

const MS_PER_DAY = 86_400_000;

export async function runScan(db: Db, client: PublicClient, strategy: LoadedStrategy, now: () => Date): Promise<ScanResult> {
  const def = strategy.definition;
  const createdAt = now().toISOString();
  const sourceErrors: ScanContent["sourceErrors"] = [];

  // Every response (including failures with a body) is stored raw; failures are recorded, never turned into empty data.
  async function fetchRows<T>(path: string, query: Record<string, string>): Promise<Fetched<T> | null> {
    const result = await client.get<T>(path, query);
    if (!result.ok) {
      if (result.raw) saveRaw(db, result.raw);
      sourceErrors.push({ endpoint: result.endpoint, error: result.error });
      return null;
    }
    return { rows: result.rows, rawRef: saveRaw(db, result.raw), receivedAt: result.raw.receivedAt };
  }

  async function fetchDerivativeExtras() {
    return {
      funding: indexById(await fetchRows<OkxFundingRow>("/api/v5/public/funding-rate", { instId: "ANY" })),
      openInterest: indexById(await fetchRows<OkxOpenInterestRow>("/api/v5/public/open-interest", { instType: "SWAP" })),
      markPrice: indexById(await fetchRows<OkxMarkPriceRow>("/api/v5/public/mark-price", { instType: "SWAP" })),
      indexTicker: indexById(await fetchRows<OkxIndexTickerRow>("/api/v5/market/index-tickers", { quoteCcy: "USDT" })),
    };
  }

  const products: ProductScanStatus[] = [];
  const candidates: ScanCandidate[] = [];
  for (const product of def.products) {
    const instType = OKX_INST_TYPE[product];
    const instruments = await fetchRows<OkxInstrumentRow>("/api/v5/public/instruments", { instType });
    const tickers = await fetchRows<OkxTickerRow>("/api/v5/market/tickers", { instType });
    if (!instruments || !tickers) {
      products.push({ product, status: "unavailable", liveInstruments: 0, missingTicker: 0, shortlisted: 0 });
      continue;
    }
    const tickerById = indexById(tickers);
    const live = parseInstruments(instruments.rows).filter((i) => i.product === product && i.state === "live");
    const { shortlist, missingTicker } = shortlistByTurnover(live, tickerById, def.shortlistPerProduct);
    const extras = product === "usdt_perpetual" ? await fetchDerivativeExtras() : null;

    for (const instrument of shortlist) {
      const book = await fetchRows<OkxBookRow>("/api/v5/market/books", { instId: instrument.instId, sz: String(def.depthLevels) });
      const sources: SnapshotSources = { ticker: tickerById.get(instrument.instId), book: firstRow(book) };
      if (extras) {
        sources.funding = extras.funding.get(instrument.instId);
        sources.openInterest = extras.openInterest.get(instrument.instId);
        sources.markPrice = extras.markPrice.get(instrument.instId);
        sources.indexTicker = extras.indexTicker.get(`${instrument.baseCcy}-USDT`);
      }
      const snapshot = buildSnapshot(client.site, instrument, sources, def.depthLevels);
      const evidence = saveEvidence(db, {
        kind: "market_snapshot",
        source: "okx_public_rest",
        publishedAt: null,
        collectedAt: now().toISOString(),
        label: "fact",
        instIds: [instrument.instId],
        content: snapshot,
        rawRef: null, // per-field raw references live inside the snapshot
        submittedBy: "scanner",
      });
      candidates.push(toCandidate(snapshot, evidence.id, def.screening, now()));
    }
    products.push({ product, status: "ok", liveInstruments: live.length, missingTicker, shortlisted: shortlist.length });
  }

  const content: ScanContent = {
    createdAt,
    site: client.site,
    strategy: { id: def.id, version: def.version, contentHash: strategy.contentHash, validation: def.validation.state },
    screening: def.screening ? "applied" : "not_configured",
    products,
    sourceErrors,
    candidates: sortCandidates(candidates),
  };
  const bundle = saveBundle(db, createdAt, content);
  appendAudit(db, createdAt, "scan.completed", bundle.id, { candidates: candidates.length, sourceErrors: sourceErrors.length });
  return { ...content, bundleId: bundle.id, bundleSha256: bundle.contentSha256 };
}

export function screenSnapshot(snapshot: MarketSnapshot, screening: Screening, at: Date): ScreenCheck[] {
  const ticker = snapshot.ticker?.value ?? null;
  const depth = snapshot.depth?.value ?? null;

  const turnover = ticker ? dec(ticker.turnover24hUsdt) : null;
  const spread = ticker ? spreadBps(ticker) : null;
  const thinnestSide = depth ? Decimal.min(dec(depth.bidNotionalUsdt), dec(depth.askNotionalUsdt)) : null;
  const listedDays = snapshot.instrument.listTime === null ? null : Math.floor((at.getTime() - Date.parse(snapshot.instrument.listTime)) / MS_PER_DAY);
  const oldest = oldestExchangeTs(snapshot);
  const ageMs = oldest === null ? null : at.getTime() - Date.parse(oldest);

  return [
    { rule: "turnover_24h", pass: turnover !== null && turnover.gte(dec(screening.minTurnover24hUsdt)), actual: turnover?.toFixed() ?? null, threshold: `>= ${screening.minTurnover24hUsdt} USDT` },
    { rule: "spread", pass: spread !== null && spread.gte(0) && spread.lte(dec(screening.maxSpreadBps)), actual: spread ? round4(spread) : null, threshold: `<= ${screening.maxSpreadBps} bps` },
    { rule: "depth_per_side", pass: thinnestSide !== null && thinnestSide.gte(dec(screening.minDepthUsdtPerSide)), actual: thinnestSide?.toFixed() ?? null, threshold: `>= ${screening.minDepthUsdtPerSide} USDT per side` },
    { rule: "listing_age", pass: listedDays !== null && listedDays >= screening.minListingDays, actual: listedDays === null ? null : String(listedDays), threshold: `>= ${screening.minListingDays} days` },
    { rule: "data_complete", pass: snapshot.gaps.length === 0, actual: snapshot.gaps.length === 0 ? "no gaps" : snapshot.gaps.join(","), threshold: "no gaps" },
    { rule: "data_fresh", pass: ageMs !== null && ageMs <= screening.maxDataAgeMs, actual: ageMs === null ? null : String(ageMs), threshold: `<= ${screening.maxDataAgeMs} ms` },
  ];
}

function toCandidate(snapshot: MarketSnapshot, evidenceId: string, screening: Screening | null, at: Date): ScanCandidate {
  const ticker = snapshot.ticker?.value ?? null;
  const change = ticker ? change24hPct(ticker) : null;
  const spread = ticker ? spreadBps(ticker) : null;
  let outcome: ScanCandidate["screening"] = { state: "not_configured" };
  if (screening) {
    const checks = screenSnapshot(snapshot, screening, at);
    outcome = { state: "applied", passed: checks.every((check) => check.pass), checks };
  }
  return {
    instId: snapshot.instId,
    product: snapshot.product,
    snapshotEvidenceId: evidenceId,
    turnover24hUsdt: ticker ? ticker.turnover24hUsdt : null,
    change24hPct: change ? round4(change) : null,
    spreadBps: spread ? round4(spread) : null,
    screening: outcome,
  };
}

function change24hPct(ticker: TickerFields): Decimal | null {
  const open = dec(ticker.open24h);
  if (open.isZero()) return null;
  return dec(ticker.last).sub(open).div(open).mul(100);
}

function spreadBps(ticker: TickerFields): Decimal | null {
  const bid = dec(ticker.bid);
  const ask = dec(ticker.ask);
  const mid = bid.add(ask).div(2);
  if (mid.isZero()) return null;
  return ask.sub(bid).div(mid).mul(10_000);
}

/** Display rounding only; pass/fail comparisons use full precision. */
function round4(value: Decimal): string {
  return value.toDecimalPlaces(4).toFixed();
}

function shortlistByTurnover(
  live: Instrument[],
  tickers: Map<string, Sourced<OkxTickerRow>>,
  limit: number,
): { shortlist: Instrument[]; missingTicker: number } {
  const ranked: Array<{ instrument: Instrument; turnover: Decimal }> = [];
  let missingTicker = 0;
  for (const instrument of live) {
    const ticker = tickers.get(instrument.instId);
    const fields = ticker ? tickerFields(instrument, ticker.row) : null;
    if (fields) ranked.push({ instrument, turnover: dec(fields.turnover24hUsdt) });
    else missingTicker += 1;
  }
  ranked.sort((a, b) => b.turnover.comparedTo(a.turnover));
  return { shortlist: ranked.slice(0, limit).map((r) => r.instrument), missingTicker };
}

function sortCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const passRank = (c: ScanCandidate) => (c.screening.state === "applied" && c.screening.passed ? 0 : 1);
  const absChange = (c: ScanCandidate) => (c.change24hPct === null ? new Decimal(-1) : dec(c.change24hPct).abs());
  return [...candidates].sort((a, b) => passRank(a) - passRank(b) || absChange(b).comparedTo(absChange(a)));
}

function oldestExchangeTs(snapshot: MarketSnapshot): string | null {
  const groups: Array<{ exchangeTs: string | null } | null> = [snapshot.ticker, snapshot.depth];
  if (snapshot.derivatives !== "not_applicable") {
    const d = snapshot.derivatives;
    groups.push(d.funding, d.openInterest, d.markPx, d.indexPx);
  }
  const present = groups.filter((group) => group !== null);
  // A present group with an unparseable exchange time cannot be proven fresh, so the whole snapshot is undated.
  if (present.some((group) => group.exchangeTs === null)) return null;
  const times = present.flatMap((group) => (group.exchangeTs ? [group.exchangeTs] : []));
  // ISO-8601 UTC strings from toISOString sort chronologically.
  return times.length === 0 ? null : ([...times].sort()[0] ?? null);
}

function indexById<T extends { instId: string }>(fetched: Fetched<T> | null): Map<string, Sourced<T>> {
  const map = new Map<string, Sourced<T>>();
  if (!fetched) return map;
  for (const row of fetched.rows) map.set(row.instId, { row, rawRef: fetched.rawRef, receivedAt: fetched.receivedAt });
  return map;
}

function firstRow<T>(fetched: Fetched<T> | null): Sourced<T> | undefined {
  const row = fetched?.rows[0];
  return fetched && row ? { row, rawRef: fetched.rawRef, receivedAt: fetched.receivedAt } : undefined;
}
