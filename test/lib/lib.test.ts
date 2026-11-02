import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal, dec } from "../../src/lib/decimal.ts";
import { canonicalJson, hashJson, sha256 } from "../../src/lib/hash.ts";
import { newId } from "../../src/lib/ids.ts";
import { msToIso } from "../../src/lib/time.ts";
import { DomainError } from "../../src/lib/errors.ts";

test("canonicalJson sorts keys at every depth and drops undefined values", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } }),
    '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
  );
});

test("hashJson is independent of key order and is a SHA-256 hex digest", () => {
  assert.equal(hashJson({ a: 1, b: "x" }), hashJson({ b: "x", a: 1 }));
  assert.equal(hashJson({ a: 1 }), sha256('{"a":1}'));
  assert.match(hashJson({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("Decimal keeps 50 significant digits instead of decimal.js's default 20", () => {
  assert.equal(new Decimal("59878.777").mul("80580.1").toFixed(), "4825037838.5377");
  assert.equal(new Decimal("123456789012345678901234.5").mul("1").toFixed(), "123456789012345678901234.5");
});

test("dec parses OKX decimal strings and rejects empty or exponent forms", () => {
  assert.equal(dec("0.0000500000000000").toFixed(), "0.00005");
  assert.equal(dec("-1.5").toFixed(), "-1.5");
  assert.throws(() => dec(""), /not a decimal string/);
  assert.throws(() => dec("1e5"), /not a decimal string/);
});

test("msToIso converts OKX millisecond strings and returns null for empty or malformed input", () => {
  assert.equal(msToIso("1793188800000"), "2026-10-28T12:00:00.000Z");
  assert.equal(msToIso(""), null);
  assert.equal(msToIso("abc"), null);
  assert.equal(msToIso("99999999999999999999"), null);
});

test("newId is prefixed and unique", () => {
  const a = newId("ev");
  const b = newId("ev");
  assert.match(a, /^ev_[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("DomainError carries a code and violations", () => {
  const err = new DomainError("INVALID_INPUT", "bad", [{ ruleId: "x.y", field: "f" }]);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "INVALID_INPUT");
  assert.deepEqual(err.violations, [{ ruleId: "x.y", field: "f" }]);
  assert.equal(err.message, "bad");
});
