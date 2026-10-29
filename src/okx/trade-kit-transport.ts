import { readFileSync, statSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DomainError } from "../lib/errors.ts";
import { createDemoReadSession, TRADE_KIT_VERSION, type DemoScope, type DemoSite } from "./trade-kit-demo-reader.ts";

const BASE_URLS: Record<DemoSite, string> = { global: "https://www.okx.com", eea: "https://eea.okx.com", us: "https://us.okx.com", tr: "https://tr.okx.com" };
const profileSchema = z.object({
  api_key: z.string().trim().min(1).max(512), secret_key: z.string().trim().min(1).max(512), passphrase: z.string().trim().min(1).max(512),
  demo: z.literal(true), site: z.enum(["global", "eea", "us", "tr"]), base_url: z.string().optional(),
  proxy_url: z.url({ protocol: /^https?$/ }).optional(),
});

function configurationError(ruleId: string): never {
  throw new DomainError("DEPENDENCY_UNAVAILABLE", "A dedicated demo profile with matching site and API credentials is required in ~/.okx/config.toml", [{ ruleId }]);
}

/** Parse secrets only in the credential-owning process. This function returns no credential values or parser diagnostics. */
export function validateDemoProfileText(text: string, profileName: string, site: DemoSite): { demo: true; site: DemoSite; baseUrl: string } {
  parseDemoProfile(text, profileName, site);
  return { demo: true, site, baseUrl: BASE_URLS[site] };
}

function parseDemoProfile(text: string, profileName: string, site: DemoSite) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profileName) || !Object.hasOwn(BASE_URLS, site) || text.length > 1024 * 1024) configurationError("tradekit.profile_scope");
  let config: unknown;
  try { config = parse(text); } catch { configurationError("tradekit.profile_parse"); }
  const root = z.object({ profiles: z.record(z.string(), z.unknown()) }).safeParse(config);
  if (!root.success || !Object.hasOwn(root.data.profiles, profileName)) configurationError("tradekit.profile_present");
  const selected = profileSchema.safeParse(root.data.profiles[profileName]);
  if (!selected.success || selected.data.site !== site) configurationError("tradekit.demo_profile");
  if (selected.data.base_url !== undefined && selected.data.base_url.replace(/\/+$/, "") !== BASE_URLS[site]) configurationError("tradekit.official_origin");
  return selected.data;
}

/** Backend-only connection. The child owns credentials; research callers receive no raw MCP transport. */
export async function connectTradeKitDemoReader(input: { scopeId: string; profile: string; site: DemoSite }, options: { homeDirectory?: string } = {}) {
  const home = options.homeDirectory ?? homedir();
  const configPath = join(home, ".okx", "config.toml");
  let text: string;
  try {
    if (statSync(configPath).size > 1024 * 1024) configurationError("tradekit.profile_size");
    text = readFileSync(configPath, "utf8");
  } catch { configurationError("tradekit.profile_readable"); }
  const selected = parseDemoProfile(text, input.profile, input.site);
  const entry = fileURLToPath(import.meta.resolve("@okx_ai/okx-trade-mcp"));
  const metadata = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as { version?: string };
  if (metadata.version !== TRADE_KIT_VERSION) configurationError("tradekit.package_pinned");

  // The published bundle includes its own older TOML parser. It must not reparse the original credential file.
  // Use an empty isolated home and pass only the selected credentials through the private child environment.
  const isolatedHome = realpathSync(mkdtempSync(join(tmpdir(), "taoalpha-okx-child-")));
  const withinTemp = relative(realpathSync(tmpdir()), isolatedHome);
  if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) configurationError("tradekit.isolated_home");
  const cleanup = () => rmSync(isolatedHome, { recursive: true, force: true });
  const env: Record<string, string> = { HOME: isolatedHome, USERPROFILE: isolatedHome, OKX_UPDATE_CHECK: "false",
    OKX_API_KEY: selected.api_key, OKX_SECRET_KEY: selected.secret_key, OKX_PASSPHRASE: selected.passphrase, OKX_API_BASE_URL: BASE_URLS[input.site] };
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  if (selected.proxy_url) { env.HTTPS_PROXY = selected.proxy_url; env.HTTP_PROXY = selected.proxy_url; }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entry, "--profile", input.profile, "--demo", "--read-only", "--modules", "account,spot,swap", "--site", input.site, "--no-log"],
    env, stderr: "pipe" });
  // Upstream errors can contain account data or configuration fragments; never forward them to a model/log.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "taoalpha-demo-reader", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const scope: DemoScope = { scopeId: input.scopeId, site: input.site, environment: "demo" };
    const session = await createDemoReadSession({
      getServerVersion: () => client.getServerVersion(),
      listTools: () => client.listTools({}, { timeout: 10_000 }),
      callTool: (request) => client.callTool(request, undefined, { timeout: 15_000 }),
    }, scope);
    return { ...session, close: async () => { try { await client.close(); } finally { cleanup(); } } };
  } catch {
    await client.close().catch(() => {});
    cleanup();
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Trade Kit demo session could not be verified", [{ ruleId: "tradekit.session_verified" }]);
  }
}
