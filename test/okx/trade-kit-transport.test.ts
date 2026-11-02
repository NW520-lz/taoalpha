import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { connectTradeKitDemoReader, validateDemoProfileText } from "../../src/okx/trade-kit-transport.ts";

const syntheticConfig = `[profiles.synthetic_demo]
api_key = "synthetic-not-an-api-key"
secret_key = "synthetic-not-a-secret"
passphrase = "synthetic-not-a-passphrase"
demo = true
site = "global"
`;

test("demo profile validation returns metadata only and rejects live/site/origin/config errors without exposing content", () => {
  assert.deepEqual(validateDemoProfileText(syntheticConfig, "synthetic_demo", "global"), { demo: true, site: "global", baseUrl: "https://www.okx.com" });
  for (const config of [syntheticConfig.replace("demo = true", "demo = false"), syntheticConfig.replace('site = "global"', 'site = "us"'), `${syntheticConfig}base_url = "https://example.invalid"`, "invalid = [synthetic-not-a-secret"]) {
    assert.throws(() => validateDemoProfileText(config, "synthetic_demo", "global"), (error: Error) => {
      assert.doesNotMatch(error.message, /synthetic-not|example\.invalid/);
      return true;
    });
  }
});

test("pinned installed Trade Kit completes a real stdio demo/read-only handshake with a synthetic profile and no exchange requests", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taoalpha-tradekit-home-"));
  const resolved = realpathSync(home);
  const withinTemp = relative(realpathSync(tmpdir()), resolved);
  assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));
  mkdirSync(join(home, ".okx"));
  writeFileSync(join(home, ".okx", "config.toml"), syntheticConfig);
  t.after(() => rmSync(resolved, { recursive: true, force: true }));
  const reader = await connectTradeKitDemoReader({ scopeId: "synthetic-demo", profile: "synthetic_demo", site: "global" }, { homeDirectory: home });
  await reader.close();
});
