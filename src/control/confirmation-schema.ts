import { z } from "zod";
import { canonicalJson } from "../lib/hash.ts";
import { DomainError } from "../lib/errors.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
export interface ReadonlyJsonObject { readonly [key: string]: ReadonlyJsonValue }
export interface ConfirmationSubject {
  version: number;
  kind: "risk_policy" | "account_baseline" | "trade_plan" | "risk_recovery" | "live_activation";
  scopeId: string;
  /** Backend account registry reference, never a credential or exchange account identifier. */
  accountRef: string;
  site: "global" | "eea" | "us" | "tr";
  environment: "demo" | "live";
  payload: JsonObject;
  expiresAt: string;
}
export interface TrustedReview {
  subject: Readonly<Omit<ConfirmationSubject, "payload">> & { readonly payload: ReadonlyJsonObject };
  subjectHash: string;
  challenge: string;
  expiresAt: string;
}
/** INTERNAL backend DI/test boundary. Never construct this from CLI/MCP/HTTP input.
 * Provider must display complete content and exact hash and verify actual user presence.
 * No security against malicious code with the same OS/database privileges is claimed.
 */
export interface TrustedPresence {
  reviewAndVerify(input: Readonly<TrustedReview>): Promise<{ status: "verified" | "denied" | "unavailable" | "timeout" }>;
}
export interface ConfirmationProposal { requestId: string; subjectHash: string; expiresAt: string }
export type ConfirmationOutcome = "verified" | "denied" | "unavailable" | "timeout" | "expired";
export interface ConfirmationDecision { status: ConfirmationOutcome; receiptId?: string }
export interface ConfirmationSummary extends ConfirmationProposal {
  status: "pending" | "unknown" | "consumed" | ConfirmationOutcome;
  receiptId?: string;
}
export interface ConfirmationReceipt {
  receiptId: string;
  requestId: string;
  subjectHash: string;
  version: number;
  kind: ConfirmationSubject["kind"];
  scopeId: string;
  accountRef: string;
  site: ConfirmationSubject["site"];
  environment: ConfirmationSubject["environment"];
  confirmedAt: string;
  expiresAt: string;
}

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const subjectSchema = z.strictObject({
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["risk_policy", "account_baseline", "trade_plan", "risk_recovery", "live_activation"]),
  scopeId: reference, accountRef: z.string().regex(/^account:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  site: z.enum(["global", "eea", "us", "tr"]), environment: z.enum(["demo", "live"]),
  payload: z.record(z.string(), z.unknown()), expiresAt: z.iso.datetime({ offset: true }),
});
const proposalSchema = z.strictObject({ requestRef: reference, subject: subjectSchema });
function invalid(): never {
  throw new DomainError("INVALID_INPUT", "Confirmation input is invalid", [{ ruleId: "confirmation.subject_schema" }]);
}
/** Reject lossy/non-JSON serialization before canonicalization (including getters and sparse arrays).
 * Obvious credential keys are rejected conservatively; callers still own credential-free payloads.
 * This is an envelope, not semantic validation of a policy, baseline, card or recovery plan.
 */
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 128) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  // Subclasses can override methods used by canonicalJson and rewrite reviewed content.
  if (array && Object.getPrototypeOf(value) !== Array.prototype) invalid();
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  ancestors.add(value);
  if (array && Object.keys(value).length !== value.length) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    // Zod records may omit this own JSON key; never approve a lossy projection.
    if (typeof key !== "string" || key === "__proto__") invalid();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (["apikey", "secret", "secretkey", "passphrase", "accesstoken", "refreshtoken", "credential", "credentials", "authorization", "privatekey", "password"].includes(normalizedKey)) invalid();
    assertJson(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
export function parseConfirmationProposal(input: unknown): { requestRef: string; subject: ConfirmationSubject } {
  try {
    assertJson(input);
    const parsed = proposalSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(canonicalJson(parsed.data.subject.payload), "utf8") > 65536) invalid();
    const originalJson = canonicalJson(input);
    if (originalJson !== canonicalJson(parsed.data)) invalid();
    return JSON.parse(originalJson) as { requestRef: string; subject: ConfirmationSubject };
  } catch { invalid(); }
}

/** Explicitly installed by confirmation service, preserving legacy store tables. */
export const CONFIRMATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS confirmation_requests (
    id TEXT PRIMARY KEY, request_ref TEXT NOT NULL UNIQUE, subject_json TEXT NOT NULL,
    subject_hash TEXT NOT NULL, challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS confirmation_claims (
    request_id TEXT PRIMARY KEY REFERENCES confirmation_requests(id), claim_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS confirmation_decisions (
    request_id TEXT PRIMARY KEY REFERENCES confirmation_requests(id), claim_id TEXT REFERENCES confirmation_claims(claim_id),
    outcome TEXT NOT NULL CHECK(outcome IN ('verified','denied','unavailable','timeout','expired')), decided_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS confirmation_receipts (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES confirmation_decisions(request_id),
    subject_hash TEXT NOT NULL, receipt_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS confirmation_consumptions (
    receipt_id TEXT PRIMARY KEY REFERENCES confirmation_receipts(id), consumed_at TEXT NOT NULL
  )`,
  ...["confirmation_requests", "confirmation_claims", "confirmation_decisions", "confirmation_receipts", "confirmation_consumptions"].flatMap((table) => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'confirmation records are immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'confirmation records are immutable'); END`,
  ]),
];
