/**
 * Read-only client for OKX public REST endpoints. It never signs requests and only sends GET requests
 * to /api/v5/public and /api/v5/market paths, so it cannot reach trading or account APIs.
 */
export const OKX_SITES = { global: "https://www.okx.com" } as const;
export type OkxSite = keyof typeof OKX_SITES;

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: "GET"; signal: AbortSignal }) => Promise<HttpResponseLike>;

export interface RawResponse {
  /** Path plus query string, e.g. "/api/v5/market/tickers?instType=SPOT". */
  endpoint: string;
  /** Local receive time (ISO 8601). */
  receivedAt: string;
  status: number;
  body: string;
}

export type PublicError =
  | { kind: "network"; message: string }
  | { kind: "http"; status: number }
  | { kind: "parse"; message: string }
  | { kind: "okx"; code: string; msg: string };

export type PublicResult<T> =
  | { ok: true; endpoint: string; rows: T[]; raw: RawResponse }
  | { ok: false; endpoint: string; error: PublicError; raw: RawResponse | null };

export interface PublicClient {
  readonly site: OkxSite;
  get<T>(path: string, query: Record<string, string>): Promise<PublicResult<T>>;
}

export interface PublicClientOptions {
  site?: OkxSite;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

const READ_ONLY_PREFIXES = ["/api/v5/public/", "/api/v5/market/"];

export function createPublicClient(options: PublicClientOptions = {}): PublicClient {
  const site = options.site ?? "global";
  const baseUrl = OKX_SITES[site];
  const fetchFn: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());

  async function get<T>(path: string, query: Record<string, string>): Promise<PublicResult<T>> {
    // Compare the path as the URL parser normalizes it, so dot segments, encoded dot segments,
    // query strings and fragments cannot slip past the prefix check and resolve elsewhere.
    const normalized = new URL(path, baseUrl).pathname;
    if (normalized !== path || !READ_ONLY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`public client only reads /api/v5/public and /api/v5/market, got ${path}`);
    }
    const endpoint = `${path}?${new URLSearchParams(query).toString()}`;
    let status: number;
    let body: string;
    try {
      const response = await fetchFn(`${baseUrl}${endpoint}`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
      status = response.status;
      body = await response.text();
    } catch (err) {
      return { ok: false, endpoint, error: { kind: "network", message: errorMessage(err) }, raw: null };
    }
    const raw: RawResponse = { endpoint, receivedAt: now().toISOString(), status, body };
    if (status !== 200) return { ok: false, endpoint, error: { kind: "http", status }, raw };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return { ok: false, endpoint, error: { kind: "parse", message: errorMessage(err) }, raw };
    }
    if (!isEnvelope(parsed)) {
      return { ok: false, endpoint, error: { kind: "parse", message: "response is not an OKX {code,data} envelope" }, raw };
    }
    if (parsed.code !== "0") {
      const msg = typeof parsed.msg === "string" ? parsed.msg : "";
      return { ok: false, endpoint, error: { kind: "okx", code: parsed.code, msg }, raw };
    }
    return { ok: true, endpoint, rows: parsed.data as T[], raw };
  }

  return { site, get };
}

function isEnvelope(value: unknown): value is { code: string; msg?: unknown; data: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string" && Array.isArray(candidate.data);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
