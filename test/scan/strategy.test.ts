import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStrategy, parseStrategy } from "../../src/scan/strategy.ts";
import { hashJson } from "../../src/lib/hash.ts";
import { testStrategy } from "../helpers/market-fixtures.ts";
import { expectDomainError } from "../helpers/assertions.ts";

const base = () => structuredClone(testStrategy().definition);

test("the shipped example strategy parses, is unvalidated, and is content-hashed", () => {
  const loaded = loadStrategy("config/strategies/volume-flow.example.json");
  assert.equal(loaded.definition.validation.state, "unvalidated");
  assert.equal(loaded.contentHash, hashJson(loaded.definition));
});

test("a strategy cannot declare itself validated in M0", () => {
  expectDomainError(() => parseStrategy({ ...base(), validation: { state: "validated" } }, "x"), "INVALID_INPUT", { field: "validation.state" });
});

test("screening may be null, which means unscreened factual ranking only", () => {
  assert.equal(parseStrategy({ ...base(), screening: null }, "x").definition.screening, null);
});

test("thresholds must be decimal strings, not JavaScript numbers", () => {
  const strategy = base();
  expectDomainError(
    () => parseStrategy({ ...strategy, screening: { ...strategy.screening, minTurnover24hUsdt: 5000000 } }, "x"),
    "INVALID_INPUT",
    { field: "screening.minTurnover24hUsdt" },
  );
});

test("unknown fields are rejected so a typo cannot silently drop a rule", () => {
  const strategy = base();
  expectDomainError(() => parseStrategy({ ...strategy, screening: { ...strategy.screening, maxSpreadBp: "10" } }, "x"), "INVALID_INPUT");
});

test("unreadable or malformed strategy files are INVALID_INPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "taoalpha-strategy-"));
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  expectDomainError(() => loadStrategy(join(dir, "missing.json")), "INVALID_INPUT", { ruleId: "strategy.readable" });
  expectDomainError(() => loadStrategy(broken), "INVALID_INPUT", { ruleId: "strategy.json" });
});

test("products must not repeat", () => {
  expectDomainError(() => parseStrategy({ ...base(), products: ["spot", "spot"] }, "x"), "INVALID_INPUT", { field: "products" });
});
