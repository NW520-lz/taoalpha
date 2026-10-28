import type { Db } from "./db.ts";

/** Append-only audit trail. Never pass credentials or account secrets in `detail`. */
export function appendAudit(db: Db, at: string, type: string, ref: string, detail: unknown): void {
  db.prepare("INSERT INTO audit_events (at, type, ref, detail) VALUES (?, ?, ?, ?)").run(at, type, ref, JSON.stringify(detail));
}
