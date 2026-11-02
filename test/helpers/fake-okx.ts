import type { PublicClient, PublicError, PublicResult } from "../../src/okx/public-client.ts";

/** A canned response: rows on success, or a client-level error. */
export type Route = { rows: unknown[] } | { error: PublicError };

/** Routes are keyed by full endpoint, e.g. "/api/v5/market/tickers?instType=SPOT". Unknown endpoints answer HTTP 404. */
export function createFakeClient(routes: Record<string, Route>, receivedAt = "2026-10-28T12:00:00.000Z") {
  const calls: string[] = [];
  const client: PublicClient = {
    site: "global",
    async get<T>(path: string, query: Record<string, string>): Promise<PublicResult<T>> {
      const endpoint = `${path}?${new URLSearchParams(query).toString()}`;
      calls.push(endpoint);
      const route = routes[endpoint];
      if (!route) return { ok: false, endpoint, error: { kind: "http", status: 404 }, raw: { endpoint, receivedAt, status: 404, body: "" } };
      if ("error" in route) return { ok: false, endpoint, error: route.error, raw: null };
      const body = JSON.stringify({ code: "0", msg: "", data: route.rows });
      return { ok: true, endpoint, rows: route.rows as T[], raw: { endpoint, receivedAt, status: 200, body } };
    },
  };
  return { client, calls };
}
