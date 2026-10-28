import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstruments, type OkxInstrumentRow } from "../../src/market/instruments.ts";

function row(overrides: Partial<OkxInstrumentRow> & Pick<OkxInstrumentRow, "instId" | "instType">): OkxInstrumentRow {
  return {
    baseCcy: "",
    quoteCcy: "",
    settleCcy: "",
    ctType: "",
    ctVal: "",
    ctValCcy: "",
    state: "live",
    listTime: "1611907686000",
    tickSz: "0.1",
    lotSz: "0.00000001",
    minSz: "0.00001",
    ...overrides,
  };
}

test("keeps USDT spot and USDT-settled linear perpetuals only", () => {
  const parsed = parseInstruments([
    row({ instId: "BTC-USDT", instType: "SPOT", baseCcy: "BTC", quoteCcy: "USDT" }),
    row({ instId: "BTC-USDC", instType: "SPOT", baseCcy: "BTC", quoteCcy: "USDC" }),
    row({
      instId: "BTC-USDT-SWAP",
      instType: "SWAP",
      settleCcy: "USDT",
      ctType: "linear",
      ctVal: "0.01",
      ctValCcy: "BTC",
      listTime: "1573557408000",
      lotSz: "0.01",
      minSz: "0.01",
    }),
    row({ instId: "BTC-USD-SWAP", instType: "SWAP", settleCcy: "BTC", ctType: "inverse", ctVal: "100", ctValCcy: "USD" }),
  ]);
  assert.deepEqual(parsed, [
    {
      instId: "BTC-USDT",
      product: "spot",
      baseCcy: "BTC",
      quoteCcy: "USDT",
      state: "live",
      listTime: "2021-01-29T08:08:06.000Z",
      tickSz: "0.1",
      lotSz: "0.00000001",
      minSz: "0.00001",
      ctVal: null,
    },
    {
      instId: "BTC-USDT-SWAP",
      product: "usdt_perpetual",
      baseCcy: "BTC",
      quoteCcy: "USDT",
      state: "live",
      listTime: "2019-11-12T11:16:48.000Z",
      tickSz: "0.1",
      lotSz: "0.01",
      minSz: "0.01",
      ctVal: "0.01",
    },
  ]);
});

test("an empty listTime stays null instead of becoming epoch zero", () => {
  const [parsed] = parseInstruments([row({ instId: "NEW-USDT", instType: "SPOT", baseCcy: "NEW", quoteCcy: "USDT", listTime: "" })]);
  assert.equal(parsed?.listTime, null);
});

test("keeps non-live instruments so the scanner can exclude them explicitly", () => {
  const [parsed] = parseInstruments([row({ instId: "OLD-USDT", instType: "SPOT", baseCcy: "OLD", quoteCcy: "USDT", state: "suspend" })]);
  assert.equal(parsed?.state, "suspend");
});

test("a linear USDT swap without ctVal is excluded", () => {
  const parsed = parseInstruments([
    row({ instId: "BTC-USDT-SWAP", instType: "SWAP", settleCcy: "USDT", ctType: "linear", ctVal: "", ctValCcy: "BTC" }),
  ]);
  assert.deepEqual(parsed, []);
});

test("a linear USDT swap with a non-numeric ctVal is excluded", () => {
  const parsed = parseInstruments([
    row({ instId: "BTC-USDT-SWAP", instType: "SWAP", settleCcy: "USDT", ctType: "linear", ctVal: "abc", ctValCcy: "BTC" }),
  ]);
  assert.deepEqual(parsed, []);
});
