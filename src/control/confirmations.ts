import { randomBytes } from "node:crypto";
import { canonicalJson, hashJson } from "../lib/hash.ts";
import { newId } from "../lib/ids.ts";
import { DomainError } from "../lib/errors.ts";
import { getRow, inTransaction, type Db } from "../store/db.ts";
import { CONFIRMATION_SCHEMA, parseConfirmationProposal } from "./confirmation-schema.ts";
import type { ConfirmationDecision, ConfirmationProposal, ConfirmationReceipt, ConfirmationSubject, ConfirmationSummary, TrustedPresence } from "./confirmation-schema.ts";

interface RequestRow { id: string; subject_json: string; subject_hash: string; challenge: string; created_at: string; expires_at: string }
interface ReceiptRow { id: string; request_id: string; subject_hash: string; receipt_json: string }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(ruleId: string, code: "INVALID_INPUT" | "IDEMPOTENCY_CONFLICT" | "PERSISTENCE_UNAVAILABLE" = "INVALID_INPUT"): never {
  throw new DomainError(code, "Confirmation operation rejected", [{ ruleId }]);
}
function safely<T>(fn: () => T): T {
  try { return fn(); }
  catch (error) { if (error instanceof DomainError) throw error; fail("confirmation.persistence", "PERSISTENCE_UNAVAILABLE"); }
}

/** Internal backend service. A receipt is confirmation evidence, never trading authorization. */
export function createConfirmationService(db: Db, presence: TrustedPresence, now: () => Date) {
  function clock(): Date {
    try {
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || at.getTime() <= 0) fail("confirmation.clock");
      return new Date(at.getTime());
    } catch { fail("confirmation.clock"); }
  }
  function transaction<T>(fn: () => T): T {
    if (db.isTransaction) fail("confirmation.own_transaction");
    return inTransaction(db, fn);
  }
  safely(() => transaction(() => { for (const sql of CONFIRMATION_SCHEMA) db.exec(sql); }));
  function load(requestId: string) {
    const row = getRow<RequestRow>(db, "SELECT * FROM confirmation_requests WHERE id = ?", requestId);
    if (!row) fail("confirmation.request_exists");
    return row;
  }
  function proposal(row: RequestRow): ConfirmationProposal { return { requestId: row.id, subjectHash: row.subject_hash, expiresAt: row.expires_at }; }
  function frozenSubject(row: RequestRow): ConfirmationSubject {
    try {
      const subject = parseConfirmationProposal({ requestRef: "internal", subject: JSON.parse(row.subject_json) }).subject;
      if (canonicalJson(subject) !== row.subject_json || hashJson(subject) !== row.subject_hash || subject.expiresAt !== row.expires_at || !/^[a-f0-9]{64}$/.test(row.challenge)) fail("confirmation.frozen_integrity");
      return subject;
    } catch { fail("confirmation.frozen_integrity"); }
  }
  async function verify(row: RequestRow, subject: ConfirmationSubject): Promise<ConfirmationDecision["status"]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Date.parse(row.expires_at) - clock().getTime();
      if (remaining <= 0) return "expired";
      const waitMs = Math.min(remaining, 2_147_483_647);
      const timeout = new Promise<unknown>((resolve) => { timer = setTimeout(() => resolve({ status: "timeout" }), waitMs); });
      const result: unknown = await Promise.race([
        presence.reviewAndVerify(freeze({ subject, subjectHash: row.subject_hash, challenge: row.challenge, expiresAt: row.expires_at })), timeout,
      ]);
      if (!result || typeof result !== "object" || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null) || Reflect.ownKeys(result).length !== 1) return "unavailable";
      const descriptor = Object.getOwnPropertyDescriptor(result, "status");
      if (!descriptor?.enumerable || !("value" in descriptor) || !["verified", "denied", "unavailable", "timeout"].includes(descriptor.value)) return "unavailable";
      return descriptor.value as ConfirmationDecision["status"];
    } catch { return "unavailable"; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  function getReceipt(receiptId: string): ConfirmationReceipt {
    return safely(() => {
      const row = getRow<ReceiptRow>(db, "SELECT * FROM confirmation_receipts WHERE id = ?", receiptId);
      if (!row) fail("confirmation.receipt_exists");
      const request = load(row.request_id);
      const subject = frozenSubject(request);
      const decision = getRow<{ outcome: string; decided_at: string }>(db, "SELECT outcome,decided_at FROM confirmation_decisions WHERE request_id = ?", request.id);
      if (decision?.outcome !== "verified") fail("confirmation.receipt_integrity");
      const receipt: ConfirmationReceipt = { receiptId: row.id, requestId: request.id, subjectHash: request.subject_hash,
        version: subject.version, kind: subject.kind, scopeId: subject.scopeId, accountRef: subject.accountRef, site: subject.site, environment: subject.environment,
        confirmedAt: decision.decided_at, expiresAt: request.expires_at };
      if (row.subject_hash !== request.subject_hash || canonicalJson(receipt) !== row.receipt_json) fail("confirmation.receipt_integrity");
      return receipt;
    });
  }
  function getRequest(requestId: string): ConfirmationSummary {
    return safely(() => {
      const row = load(requestId);
      frozenSubject(row);
      const decision = getRow<{ outcome: ConfirmationDecision["status"] }>(db, "SELECT outcome FROM confirmation_decisions WHERE request_id = ?", requestId);
      const receipt = getRow<{ id: string }>(db, "SELECT id FROM confirmation_receipts WHERE request_id = ?", requestId);
      const consumed = receipt && getRow(db, "SELECT receipt_id FROM confirmation_consumptions WHERE receipt_id = ?", receipt.id);
      const claimed = getRow(db, "SELECT request_id FROM confirmation_claims WHERE request_id = ?", requestId);
      return { ...proposal(row), status: consumed ? "consumed" : decision?.outcome ?? (claimed ? "unknown" : "pending"), ...(receipt ? { receiptId: receipt.id } : {}) };
    });
  }
  return {
    propose(raw: unknown): ConfirmationProposal {
      return safely(() => {
        const input = parseConfirmationProposal(raw);
        const subjectJson = canonicalJson(input.subject);
        const subjectHash = hashJson(input.subject);
        return transaction(() => {
          const existing = getRow<RequestRow>(db, "SELECT * FROM confirmation_requests WHERE request_ref = ?", input.requestRef);
          if (existing) {
            if (existing.subject_hash !== subjectHash || existing.subject_json !== subjectJson) fail("confirmation.reference_immutable", "IDEMPOTENCY_CONFLICT");
            return proposal(existing);
          }
          const at = clock();
          if (Date.parse(input.subject.expiresAt) <= at.getTime()) fail("confirmation.expired");
          const requestId = newId("confirmation");
          db.prepare("INSERT INTO confirmation_requests (id,request_ref,subject_json,subject_hash,challenge,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
            .run(requestId, input.requestRef, subjectJson, subjectHash, randomBytes(32).toString("hex"), at.toISOString(), input.subject.expiresAt);
          return proposal(load(requestId));
        });
      });
    },
    async reviewAndConfirm(requestId: string): Promise<ConfirmationDecision> {
      if (arguments.length !== 1) fail("confirmation.review_arguments");
      const claimId = newId("claim");
      const claimed = safely(() => transaction(() => {
        const stored = load(requestId);
        frozenSubject(stored);
        if (getRow(db, "SELECT request_id FROM confirmation_decisions WHERE request_id = ?", requestId)) fail("confirmation.request_decided", "IDEMPOTENCY_CONFLICT");
        if (getRow(db, "SELECT request_id FROM confirmation_claims WHERE request_id = ?", requestId)) fail("confirmation.request_claimed", "IDEMPOTENCY_CONFLICT");
        const at = clock();
        if (Date.parse(stored.expires_at) <= at.getTime()) {
          db.prepare("INSERT INTO confirmation_decisions(request_id,outcome,decided_at) VALUES (?,?,?)").run(requestId, "expired", at.toISOString());
          return { row: stored, expired: true, at };
        }
        db.prepare("INSERT INTO confirmation_claims(request_id,claim_id,claimed_at) VALUES (?,?,?)").run(requestId, claimId, at.toISOString());
        return { row: stored, expired: false, at };
      }));
      if (claimed.expired) fail("confirmation.expired");
      const { row } = claimed;
      const subject = frozenSubject(row);
      const result = await verify(row, subject);
      return safely(() => transaction(() => {
        const current = load(requestId);
        frozenSubject(current);
        const claim = getRow<{ claim_id: string }>(db, "SELECT claim_id FROM confirmation_claims WHERE request_id = ?", requestId);
        if (claim?.claim_id !== claimId || current.subject_hash !== row.subject_hash || current.subject_json !== row.subject_json) fail("confirmation.frozen_integrity");
        const at = clock();
        if (at.getTime() < claimed.at.getTime()) fail("confirmation.clock");
        const outcome = at.getTime() >= Date.parse(row.expires_at) ? "expired" : result;
        db.prepare("INSERT INTO confirmation_decisions(request_id,claim_id,outcome,decided_at) VALUES (?,?,?,?)").run(requestId, claimId, outcome, at.toISOString());
        if (outcome !== "verified") return { status: outcome };
        const receipt: ConfirmationReceipt = { receiptId: newId("receipt"), requestId, subjectHash: row.subject_hash,
          version: subject.version, kind: subject.kind, scopeId: subject.scopeId, accountRef: subject.accountRef, site: subject.site, environment: subject.environment,
          confirmedAt: at.toISOString(), expiresAt: row.expires_at };
        db.prepare("INSERT INTO confirmation_receipts(id,request_id,subject_hash,receipt_json) VALUES (?,?,?,?)").run(receipt.receiptId, requestId, row.subject_hash, canonicalJson(receipt));
        return { status: "verified", receiptId: receipt.receiptId };
      }));
    },
    getRequest,
    getReceipt,
    /** Coordinator must own a BEGIN IMMEDIATE transaction (use inTransaction).
     * This insertion shares the coordinator's commit/rollback; it grants no execution authority.
     */
    consume(receiptId: string, expectedSubject: ConfirmationSubject): ConfirmationReceipt {
      return safely(() => {
        if (!db.isTransaction) fail("confirmation.consumption_transaction");
        const expected = parseConfirmationProposal({ requestRef: "expected", subject: expectedSubject }).subject;
        const receipt = getReceipt(receiptId);
        if (hashJson(expected) !== receipt.subjectHash || expected.version !== receipt.version || expected.kind !== receipt.kind ||
          expected.scopeId !== receipt.scopeId || expected.accountRef !== receipt.accountRef || expected.site !== receipt.site || expected.environment !== receipt.environment ||
          expected.expiresAt !== receipt.expiresAt) fail("confirmation.receipt_binding");
        const at = clock();
        if (at.getTime() >= Date.parse(receipt.expiresAt) || at.getTime() < Date.parse(receipt.confirmedAt)) fail("confirmation.receipt_expired");
        if (getRow(db, "SELECT receipt_id FROM confirmation_consumptions WHERE receipt_id = ?", receiptId)) fail("confirmation.receipt_consumed", "IDEMPOTENCY_CONFLICT");
        db.prepare("INSERT INTO confirmation_consumptions(receipt_id,consumed_at) VALUES (?,?)").run(receiptId, at.toISOString());
        return receipt;
      });
    },
  };
}
