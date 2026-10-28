const MS_PATTERN = /^\d+$/;

/** OKX timestamps are Unix milliseconds as strings; empty or malformed values become null, never epoch zero. */
export function msToIso(ms: string): string | null {
  return MS_PATTERN.test(ms) ? new Date(Number(ms)).toISOString() : null;
}
