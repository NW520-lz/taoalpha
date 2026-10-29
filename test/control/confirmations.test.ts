import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, inTransaction } from "../../src/store/db.ts";
import { hashJson } from "../../src/lib/hash.ts";
import { createConfirmationService } from "../../src/control/confirmations.ts";
import type { ConfirmationSubject, TrustedPresence } from "../../src/control/confirmation-schema.ts";
import { DomainError } from "../../src/lib/errors.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AT = new Date("2026-10-29T12:00:00Z");
function subject(overrides: Partial<ConfirmationSubject> = {}): ConfirmationSubject {
  return { version: 1, kind: "trade_plan", scopeId: "scope:synthetic", accountRef: "account:synthetic", site: "global", environment: "demo",
    payload: { planVersion: 1, riskPolicyVersion: 3, amountUsdt: "2.000000000000000001", nested: { note: "synthetic-private-payload-sentinel" } },
    expiresAt: "2026-10-29T12:01:00Z", ...overrides };
}

test("frozen complete subject reaches only trusted provider and produces an exactly bound receipt", async () => {
  const db = openDb(":memory:");
  try {
    const original = subject();
    let calls = 0;
    const presence: TrustedPresence = { async reviewAndVerify(input) {
      calls++;
      assert.equal(db.isTransaction, false);
      assert.deepEqual(input.subject, subject());
      assert.notEqual(input.subject, original);
      assert.equal(input.subjectHash, hashJson(subject()));
      assert.match(input.challenge, /^[a-f0-9]{64}$/);
      assert.equal(input.expiresAt, subject().expiresAt);
      assert.ok(Object.isFrozen(input));
      assert.ok(Object.isFrozen(input.subject.payload));
      assert.ok(Object.isFrozen(input.subject.payload.nested));
      return { status: "verified" };
    } };
    const service = createConfirmationService(db, presence, () => AT);
    const proposal = service.propose({ requestRef: "request:synthetic", subject: original });
    assert.equal(proposal.subjectHash, hashJson(subject()));
    original.payload.changed = "caller-mutation";
    const receipt = await service.reviewAndConfirm(proposal.requestId);
    assert.equal(receipt.status, "verified");
    assert.equal(calls, 1);
    assert.ok(receipt.receiptId);
    assert.deepEqual(service.getReceipt(receipt.receiptId!), {
      receiptId: receipt.receiptId, requestId: proposal.requestId, subjectHash: proposal.subjectHash,
      version: 1, kind: "trade_plan", scopeId: "scope:synthetic", accountRef: "account:synthetic", site: "global", environment: "demo",
      confirmedAt: AT.toISOString(), expiresAt: subject().expiresAt,
    });
    assert.doesNotMatch(JSON.stringify(service.getRequest(proposal.requestId)), /payload|sentinel|challenge|scope:synthetic|account:synthetic/);
    const consumed = inTransaction(db, () => service.consume(receipt.receiptId!, subject()));
    assert.equal(consumed.receiptId, receipt.receiptId);
    assert.equal(service.getRequest(proposal.requestId).status, "consumed");
  } finally { db.close(); }
});

test("strict versioned JSON rejects counterfeit approval, secrets and non-JSON values with safe errors", () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "verified" }) }, () => AT);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { throw new Error("synthetic-getter-sentinel"); } });
    const symbol = { [Symbol("synthetic-symbol-sentinel")]: true };
    const hostileProxy = new Proxy({}, { getPrototypeOf() { throw new DomainError("INVALID_INPUT", "synthetic-proxy-sentinel", [{ ruleId: "synthetic-rule-sentinel" }]); } });
    const sparse = Array(2);
    for (const invalid of [
      { ...subject(), approved: true }, { ...subject(), claimedHuman: "synthetic-human-sentinel" },
      { ...subject(), version: 0 }, { ...subject(), version: 1.5 }, { ...subject(), accountRef: "raw-private-sentinel" },
      { ...subject(), environment: "unknown" }, { ...subject(), site: "unknown" }, { ...subject(), expiresAt: "invalid-sentinel" },
      ...[undefined, null, [], { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: () => true }, { value: new Date() }, { value: new Map() }, { value: cycle }, { value: accessor }, { value: symbol }, { value: sparse }, { value: hostileProxy }, { secret_key: "synthetic-private-sentinel" }, { value: "中".repeat(22000) }].map((payload) => ({ ...subject(), payload })),
    ]) {
      assert.throws(() => service.propose({ requestRef: "request:invalid", subject: invalid } as never), (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.doesNotMatch(JSON.stringify(error) + error.message, /sentinel|22000|secret_key/);
        return true;
      });
    }
    assert.throws(() => service.propose({ requestRef: "request:invalid", subject: subject(), approved: true } as never), DomainError);
  } finally { db.close(); }
});

test("stable proposal references bind immutable canonical content and are idempotent", () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "denied" }) }, () => AT);
    const first = service.propose({ requestRef: "request:stable", subject: subject() });
    assert.deepEqual(service.propose({ requestRef: "request:stable", subject: subject() }), first);
    for (const change of [{ version: 2 }, { accountRef: "account:other" }, { environment: "live" as const }, { payload: { planVersion: 2 } }]) {
      assert.throws(() => service.propose({ requestRef: "request:stable", subject: subject(change) }), (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT");
    }
    assert.equal(service.getRequest(first.requestId).status, "pending");
  } finally { db.close(); }
});

test("atomic persistent claim allows at most one concurrent prompt and never re-prompts a decision", async () => {
  const db = openDb(":memory:");
  try {
    let release!: (value: { status: "verified" }) => void;
    let calls = 0;
    const provider: TrustedPresence = { reviewAndVerify: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } };
    const service = createConfirmationService(db, provider, () => AT);
    const second = createConfirmationService(db, provider, () => AT);
    const proposal = service.propose({ requestRef: "request:concurrent", subject: subject() });
    const firstReview = service.reviewAndConfirm(proposal.requestId);
    assert.equal(service.getRequest(proposal.requestId).status, "unknown");
    await assert.rejects(second.reviewAndConfirm(proposal.requestId), DomainError);
    assert.equal(calls, 1);
    release({ status: "verified" });
    assert.equal((await firstReview).status, "verified");
    await assert.rejects(service.reviewAndConfirm(proposal.requestId), DomainError);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("claimed-without-result persists over restart and fails closed without another prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-confirmation-"));
  let db = openDb(join(directory, "synthetic.sqlite"));
  let release!: (value: { status: "verified" }) => void;
  let calls = 0;
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => new Promise((resolve) => { calls++; release = resolve; }) }, () => AT);
    const proposal = service.propose({ requestRef: "request:crash", subject: subject() });
    const interrupted = service.reviewAndConfirm(proposal.requestId);
    assert.equal(service.getRequest(proposal.requestId).status, "unknown");
    db.close();
    db = openDb(join(directory, "synthetic.sqlite"));
    const restarted = createConfirmationService(db, { reviewAndVerify: async () => { calls++; return { status: "verified" }; } }, () => AT);
    assert.equal(restarted.getRequest(proposal.requestId).status, "unknown");
    await assert.rejects(restarted.reviewAndConfirm(proposal.requestId), DomainError);
    assert.equal(calls, 1);
    release({ status: "verified" });
    await assert.rejects(interrupted, DomainError);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("expiry before and during review creates no receipt; callers cannot provide replacement approval", async () => {
  const db = openDb(":memory:");
  try {
    let current = AT;
    let calls = 0;
    const service = createConfirmationService(db, { reviewAndVerify: async () => { calls++; current = new Date("2026-10-29T12:01:00Z"); return { status: "verified" }; } }, () => current);
    const expired = service.propose({ requestRef: "request:expire-before", subject: subject() });
    current = new Date(subject().expiresAt);
    await assert.rejects(service.reviewAndConfirm(expired.requestId), DomainError);
    assert.equal(calls, 0);
    assert.equal(service.getRequest(expired.requestId).status, "expired");
    current = AT;
    const during = service.propose({ requestRef: "request:expire-during", subject: subject() });
    await assert.rejects(Reflect.apply(service.reviewAndConfirm, service, [during.requestId, { approved: true, subject: subject({ version: 2 }) }]), DomainError);
    assert.equal(calls, 0);
    assert.equal((await service.reviewAndConfirm(during.requestId)).status, "expired");
    assert.equal(service.getRequest(during.requestId).receiptId, undefined);
    assert.throws(() => service.propose({ requestRef: "request:already-expired", subject: subject() }), DomainError);
    await assert.rejects(service.reviewAndConfirm("synthetic-missing-request-sentinel"), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel/);
      return true;
    });
  } finally { db.close(); }
});

test("denial, unavailable, exceptions and malformed runtime provider results are terminal and private", async () => {
  for (const provider of [
    { reviewAndVerify: async () => ({ status: "denied" }) },
    { reviewAndVerify: async () => ({ status: "unavailable" }) },
    { reviewAndVerify: async () => ({ status: "timeout" }) },
    { reviewAndVerify: async () => { throw new Error("synthetic-provider-private-sentinel"); } },
    { reviewAndVerify: async () => ({ status: "verified", approved: true }) },
    { reviewAndVerify: async () => ({ approved: true, human: "synthetic-human-sentinel" }) },
    { reviewAndVerify: async () => new class { status = "verified"; }() },
    { reviewAndVerify: async () => Object.defineProperty({}, "status", { value: "verified", enumerable: false }) },
    { reviewAndVerify: async () => null }, undefined,
  ]) {
    const db = openDb(":memory:");
    try {
      const service = createConfirmationService(db, provider as unknown as TrustedPresence, () => AT);
      const proposal = service.propose({ requestRef: "request:refusal", subject: subject() });
      const decision = await service.reviewAndConfirm(proposal.requestId);
      assert.notEqual(decision.status, "verified");
      assert.equal(decision.receiptId, undefined);
      assert.doesNotMatch(JSON.stringify(decision) + JSON.stringify(service.getRequest(proposal.requestId)), /sentinel|challenge|payload/);
      await assert.rejects(service.reviewAndConfirm(proposal.requestId), DomainError);
    } finally { db.close(); }
  }
});

test("a provider that never completes times out without any approval receipt", async () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => new Promise(() => {}) }, () => AT);
    const proposal = service.propose({ requestRef: "request:timeout", subject: subject({ expiresAt: new Date(AT.getTime() + 20).toISOString() }) });
    const decision = await service.reviewAndConfirm(proposal.requestId);
    assert.equal(decision.status, "timeout");
    assert.equal(decision.receiptId, undefined);
    assert.equal(service.getRequest(proposal.requestId).status, "timeout");
  } finally { db.close(); }
});

test("receipt consumption requires caller transaction, exact subject binding and a live deadline", async () => {
  const db = openDb(":memory:");
  try {
    let current = AT;
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "verified" }) }, () => current);
    const proposal = service.propose({ requestRef: "request:consume", subject: subject() });
    const decision = await service.reviewAndConfirm(proposal.requestId);
    const id = decision.receiptId!;
    assert.throws(() => service.consume(id, subject()), DomainError);
    for (const change of [{ version: 2 }, { accountRef: "account:other" }, { environment: "live" as const }, { scopeId: "scope:other" }, { site: "us" as const }, { kind: "risk_policy" as const }, { expiresAt: "2026-10-29T12:02:00Z" }, { payload: { planVersion: 2 } }]) {
      assert.throws(() => inTransaction(db, () => service.consume(id, subject(change))), DomainError);
    }
    assert.equal(service.getRequest(proposal.requestId).status, "verified");
    current = new Date(subject().expiresAt);
    assert.throws(() => inTransaction(db, () => service.consume(id, subject())), DomainError);
    current = AT;
    assert.equal(inTransaction(db, () => service.consume(id, subject())).receiptId, id);
    assert.throws(() => inTransaction(db, () => service.consume(id, subject())), DomainError);
    assert.throws(() => inTransaction(db, () => service.consume("synthetic-false-receipt-sentinel", subject())), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel/);
      return true;
    });
  } finally { db.close(); }
});

test("receipt consumption rolls back atomically with the coordinator transaction", async () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "verified" }) }, () => AT);
    const proposal = service.propose({ requestRef: "request:rollback", subject: subject() });
    const decision = await service.reviewAndConfirm(proposal.requestId);
    assert.throws(() => inTransaction(db, () => { service.consume(decision.receiptId!, subject()); throw new Error("synthetic-coordinator-failure"); }));
    assert.equal(service.getRequest(proposal.requestId).status, "verified");
    assert.equal(inTransaction(db, () => service.consume(decision.receiptId!, subject())).receiptId, decision.receiptId);
    assert.equal(service.getRequest(proposal.requestId).status, "consumed");
  } finally { db.close(); }
});

test("all confirmation records are append-only and survive restart without modifying legacy tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-confirmation-"));
  let db = openDb(join(directory, "synthetic.sqlite"));
  try {
    db.exec("CREATE TABLE legacy_synthetic(id TEXT PRIMARY KEY, value TEXT); INSERT INTO legacy_synthetic VALUES ('legacy', 'synthetic-legacy-sentinel')");
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "verified" }) }, () => AT);
    const proposal = service.propose({ requestRef: "request:immutable", subject: subject() });
    const decision = await service.reviewAndConfirm(proposal.requestId);
    inTransaction(db, () => service.consume(decision.receiptId!, subject()));
    for (const table of ["confirmation_requests", "confirmation_claims", "confirmation_decisions", "confirmation_receipts", "confirmation_consumptions"]) {
      assert.throws(() => db.exec(`UPDATE ${table} SET rowid = rowid`), /immutable/);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
      assert.throws(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /immutable/);
    }
    db.close(); db = openDb(join(directory, "synthetic.sqlite"));
    const restarted = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "verified" }) }, () => AT);
    assert.equal(restarted.getRequest(proposal.requestId).status, "consumed");
    assert.equal(restarted.getReceipt(decision.receiptId!).subjectHash, proposal.subjectHash);
    assert.equal(db.prepare("SELECT value FROM legacy_synthetic WHERE id='legacy'").get()!.value, "synthetic-legacy-sentinel");
    await assert.rejects(restarted.reviewAndConfirm(proposal.requestId), DomainError);
    assert.throws(() => inTransaction(db, () => restarted.consume(decision.receiptId!, subject())), DomainError);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("SQL lock and unavailable database errors are fixed safe domain failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-confirmation-"));
  const path = join(directory, "synthetic.sqlite");
  const db = openDb(path);
  const locker = openDb(path);
  try {
    let calls = 0;
    const service = createConfirmationService(db, { reviewAndVerify: async () => { calls++; return { status: "verified" }; } }, () => AT);
    const proposal = service.propose({ requestRef: "request:lock", subject: subject() });
    db.exec("PRAGMA busy_timeout=0");
    locker.exec("BEGIN IMMEDIATE");
    const safeError = (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "PERSISTENCE_UNAVAILABLE");
      assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel|SQLITE|locked|payload|challenge/);
      return true;
    };
    assert.throws(() => service.propose({ requestRef: "request:blocked", subject: subject() }), safeError);
    await assert.rejects(service.reviewAndConfirm(proposal.requestId), safeError);
    assert.equal(calls, 0);
    assert.throws(() => createConfirmationService(db, {} as TrustedPresence, () => AT), safeError);
    locker.exec("ROLLBACK");
    assert.equal((await service.reviewAndConfirm(proposal.requestId)).status, "verified");
    db.close();
    assert.throws(() => service.getRequest(proposal.requestId), safeError);
  } finally { if (db.isOpen) db.close(); locker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("deadline is rechecked immediately before prompting, including expiry after claim", async () => {
  const db = openDb(":memory:");
  try {
    let ticks = 0;
    let calls = 0;
    const service = createConfirmationService(db, { reviewAndVerify: async () => { calls++; return { status: "verified" }; } }, () => ++ticks >= 3 ? new Date(subject().expiresAt) : AT);
    const proposal = service.propose({ requestRef: "request:between-claim-prompt", subject: subject() });
    assert.equal((await service.reviewAndConfirm(proposal.requestId)).status, "expired");
    assert.equal(calls, 0);
    assert.equal(service.getRequest(proposal.requestId).receiptId, undefined);
  } finally { db.close(); }
});

test("payload byte limit accepts exactly 65536 canonical UTF-8 bytes and rejects one more", () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "denied" }) }, () => AT);
    const exact = subject({ payload: { value: "x".repeat(65524) } });
    assert.equal(Buffer.byteLength(JSON.stringify(exact.payload), "utf8"), 65536);
    assert.ok(service.propose({ requestRef: "request:payload-limit", subject: exact }).requestId);
    assert.throws(() => service.propose({ requestRef: "request:payload-excess", subject: subject({ payload: { value: "x".repeat(65525) } }) }), DomainError);
  } finally { db.close(); }
});

test("frozen content/hash integrity is rechecked after prompt and corrupted records never leak", async () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => {
      // Test-only corruption injection. Same-OS privileged tampering is not a supported trust boundary.
      db.exec("DROP TRIGGER confirmation_requests_no_update");
      db.prepare("UPDATE confirmation_requests SET subject_hash = ?").run("synthetic-corruption-private-sentinel");
      return { status: "verified" };
    } }, () => AT);
    const proposal = service.propose({ requestRef: "request:corruption", subject: subject() });
    const fixedError = (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel|payload|challenge/);
      return true;
    };
    await assert.rejects(service.reviewAndConfirm(proposal.requestId), fixedError);
    assert.throws(() => service.getRequest(proposal.requestId), fixedError);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM confirmation_receipts").get()!.n, 0);
  } finally { db.close(); }
});

test("own JSON __proto__ keys reject before lossy validation can collapse distinct subjects", () => {
  const db = openDb(":memory:");
  try {
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "denied" }) }, () => AT);
    const ordinary = subject({ payload: { value: "synthetic" } });
    const proposal = service.propose({ requestRef: "request:exact-original", subject: ordinary });
    const direct = JSON.parse('{"value":"synthetic","__proto__":{"note":"synthetic-proto-private-sentinel"}}');
    assert.equal(Object.hasOwn(direct, "__proto__"), true);
    assert.notEqual(hashJson(subject({ payload: direct })), proposal.subjectHash);
    for (const payload of [direct, { nested: direct }, { nested: [direct] }]) {
      assert.throws(() => service.propose({ requestRef: "request:exact-original", subject: subject({ payload }) }), (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel|__proto__/);
        return true;
      });
    }
    assert.deepEqual(service.propose({ requestRef: "request:exact-original", subject: ordinary }), proposal);
    assert.equal(service.getRequest(proposal.requestId).status, "pending");
  } finally { db.close(); }
});

test("array subclasses cannot rewrite frozen subject content through overridden serialization methods", () => {
  const db = openDb(":memory:");
  try {
    class RewrittenArray extends Array<string> {}
    Object.defineProperty(RewrittenArray.prototype, "map", { value: () => ["0"] });
    const terms = new RewrittenArray("synthetic-original-condition-sentinel");
    assert.equal(Array.isArray(terms), true);
    assert.equal(terms[0], "synthetic-original-condition-sentinel");
    const service = createConfirmationService(db, { reviewAndVerify: async () => ({ status: "denied" }) }, () => AT);
    assert.throws(() => service.propose({ requestRef: "request:rewritten-array", subject: subject({ payload: { terms } }) }), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.doesNotMatch(error.message + JSON.stringify(error), /sentinel|terms|original-condition/);
      return true;
    });
  } finally { db.close(); }
});
