import { test } from "node:test";
import assert from "node:assert/strict";
import { createWindowsPresence } from "../../src/control/windows-presence.ts";
import { hashJson } from "../../src/lib/hash.ts";

test("unsupported platforms cannot approve and never start a native process", async () => {
  let calls = 0;
  const provider = createWindowsPresence({ platform: "linux", runWorker: async () => { calls += 1; return ""; } });
  assert.deepEqual(await provider.availability(), { status: "unavailable" });
  assert.deepEqual(await provider.reviewAndVerify({ subject: {}, subjectHash: "0".repeat(64), challenge: "1".repeat(64), expiresAt: "2099-01-01T00:00:00Z" }), { status: "unavailable" });
  assert.equal(calls, 0);
});

test("native approval fails closed on changed content, missing proofs, invalid clocks and expiry during interaction", async () => {
  const at = new Date("2026-10-29T12:00:00Z");
  const subject = { kind: "trade_plan", payload: { privateSentinel: "synthetic-only" }, expiresAt: "2026-10-29T12:01:00Z" };
  const input = { subject, subjectHash: hashJson(subject), challenge: "b".repeat(64), expiresAt: subject.expiresAt };
  for (const output of ["invalid", JSON.stringify({ status: "verified" }), JSON.stringify({ status: "verified", challenge: "c".repeat(64) }), JSON.stringify({ status: "verified", challenge: input.challenge, arbitrarySecret: "synthetic-only" })]) {
    const provider = createWindowsPresence({ platform: "win32", now: () => at, runWorker: async () => output });
    assert.deepEqual(await provider.reviewAndVerify(input), { status: "unavailable" });
  }
  for (const status of ["denied", "unavailable", "timeout"] as const) {
    const provider = createWindowsPresence({ platform: "win32", now: () => at, runWorker: async () => JSON.stringify({ status, challenge: input.challenge }) });
    assert.deepEqual(await provider.reviewAndVerify(input), { status });
  }
  let calls = 0;
  const provider = createWindowsPresence({ platform: "win32", now: () => at, runWorker: async () => { calls += 1; throw new Error("synthetic-private-error"); } });
  assert.deepEqual(await provider.reviewAndVerify({ ...input, subjectHash: "d".repeat(64) }), { status: "unavailable" });
  assert.deepEqual(await provider.reviewAndVerify({ ...input, expiresAt: at.toISOString() }), { status: "timeout" });
  assert.equal(calls, 0);
  assert.deepEqual(await provider.reviewAndVerify(input), { status: "unavailable" });
  for (const after of [new Date(subject.expiresAt), new Date(NaN)]) {
    let time = at;
    const changingClock = createWindowsPresence({ platform: "win32", now: () => time, runWorker: async () => { time = after; return JSON.stringify({ status: "verified", challenge: input.challenge }); } });
    assert.notEqual((await changingClock.reviewAndVerify(input)).status, "verified");
  }
});

test("native worker verifies the exact frozen content and challenge without exposing private fields", async () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const subject = { kind: "risk_policy", payload: { syntheticPrivateAmount: "123.4567890123456789" }, expiresAt: "2026-10-29T12:01:00Z" };
  const input = { subject, subjectHash: hashJson(subject), challenge: "a".repeat(64), expiresAt: subject.expiresAt };
  const sent: unknown[] = [];
  const provider = createWindowsPresence({ platform: "win32", now: () => now, runWorker: async (mode, json) => {
    if (mode === "Check") return JSON.stringify({ status: "available" });
    const request = JSON.parse(json!);
    sent.push(request);
    assert.deepEqual(JSON.parse(request.displayText), subject);
    assert.equal(request.subjectHash, hashJson(subject));
    return JSON.stringify({ status: "verified", challenge: request.challenge });
  } });
  assert.deepEqual(await provider.availability(), { status: "available" });
  const result = await provider.reviewAndVerify(input);
  assert.deepEqual(result, { status: "verified" });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /123\.456|syntheticPrivateAmount|aaaa/);
});
