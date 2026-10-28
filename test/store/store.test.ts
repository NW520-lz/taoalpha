import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allRows, inTransaction, openDb } from "../../src/store/db.ts";
import { getBundle, getEvidence, getRaw, latestBundleId, saveBundle, saveEvidence, saveRaw, type EvidenceInput } from "../../src/store/evidence-store.ts";
import { appendAudit } from "../../src/store/audit.ts";
import { hashJson, sha256 } from "../../src/lib/hash.ts";

const RAW = { endpoint: "/api/v5/market/tickers?instType=SPOT", receivedAt: "2026-10-28T12:00:00.000Z", status: 200, body: '{"code":"0"}' };

const EVIDENCE: EvidenceInput = {
  kind: "external_source",
  source: "https://example.com/announcement",
  publishedAt: "2026-10-27T08:00:00Z",
  collectedAt: "2026-10-28T11:00:00Z",
  label: "fact",
  instIds: ["GOOD-USDT"],
  content: { excerpt: "GOOD 公告主网升级。" },
  rawRef: null,
  submittedBy: "research:run_x:fundamentals_events",
};

test("raw responses round-trip with a body hash", () => {
  const db = openDb(":memory:");
  const id = saveRaw(db, RAW);
  assert.match(id, /^raw_/);
  assert.deepEqual(getRaw(db, id), { id, ...RAW, bodySha256: sha256(RAW.body) });
  assert.equal(getRaw(db, "raw_missing"), null);
});

test("evidence items round-trip and carry a canonical content hash", () => {
  const db = openDb(":memory:");
  const saved = saveEvidence(db, EVIDENCE);
  assert.match(saved.id, /^ev_/);
  assert.equal(saved.contentSha256, hashJson(EVIDENCE.content));
  assert.deepEqual(getEvidence(db, saved.id), saved);
  assert.equal(getEvidence(db, "ev_missing"), null);
});

test("evidence items are frozen: updates and deletes are refused", () => {
  const db = openDb(":memory:");
  saveEvidence(db, EVIDENCE);
  assert.throws(() => db.exec("UPDATE evidence_items SET label = 'inference'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM evidence_items"), /immutable/);
});

test("evidence bundles round-trip, hash their content, and are frozen", () => {
  const db = openDb(":memory:");
  const content = { candidates: [{ instId: "GOOD-USDT" }], screening: "applied" };
  const bundle = saveBundle(db, "2026-10-28T12:00:00.000Z", content);
  assert.match(bundle.id, /^bundle_/);
  assert.equal(bundle.contentSha256, hashJson(content));
  assert.deepEqual(getBundle(db, bundle.id), bundle);
  assert.equal(getBundle(db, "bundle_missing"), null);
  assert.throws(() => db.exec("UPDATE evidence_bundles SET content = '{}'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM evidence_bundles"), /immutable/);
});

test("latestBundleId returns the newest bundle, or null when there is none", () => {
  const db = openDb(":memory:");
  assert.equal(latestBundleId(db), null);
  saveBundle(db, "2026-10-28T11:00:00.000Z", { n: 1 });
  const newer = saveBundle(db, "2026-10-28T12:00:00.000Z", { n: 2 });
  assert.equal(latestBundleId(db), newer.id);
});

test("inTransaction commits on success and rolls back on error", () => {
  const db = openDb(":memory:");
  inTransaction(db, () => saveRaw(db, RAW));
  assert.throws(() =>
    inTransaction(db, () => {
      saveRaw(db, RAW);
      throw new Error("boom");
    }),
  /boom/);
  assert.equal(allRows(db, "SELECT id FROM raw_responses").length, 1);
});

test("appendAudit stores events in insertion order", () => {
  const db = openDb(":memory:");
  appendAudit(db, "2026-10-28T12:00:00.000Z", "scan.completed", "bundle_1", { candidates: 3 });
  appendAudit(db, "2026-10-28T12:00:01.000Z", "research.started", "run_1", { agentMode: "serial_degraded" });
  const rows = allRows<{ type: string; ref: string; detail: string }>(db, "SELECT type, ref, detail FROM audit_events ORDER BY seq");
  assert.deepEqual(rows.map((r) => ({ type: r.type, ref: r.ref, detail: JSON.parse(r.detail) })), [
    { type: "scan.completed", ref: "bundle_1", detail: { candidates: 3 } },
    { type: "research.started", ref: "run_1", detail: { agentMode: "serial_degraded" } },
  ]);
});

test("openDb creates parent directories and reopens an existing file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "taoalpha-store-")), "nested", "dir", "test.db");
  const first = openDb(path);
  const id = saveRaw(first, RAW);
  first.close();
  const second = openDb(path);
  assert.equal(getRaw(second, id)?.body, RAW.body);
  second.close();
});
