const MS_PATTERN = /^\d+$/;

/** OKX timestamps are Unix milliseconds as strings; empty, malformed or out-of-range values become null, never epoch zero. */
export function msToIso(ms: string): string | null {
  if (!MS_PATTERN.test(ms)) return null;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
