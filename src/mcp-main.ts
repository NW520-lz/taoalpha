import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createResearchMcpServer } from "./mcp/research-server.ts";
import { createPublicClient } from "./okx/public-client.ts";
import { openDb, type Db } from "./store/db.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const configuredDb = process.env.TAOALPHA_DB ?? "data/taoalpha.db";
let db: Db | undefined;
let server: McpServer | undefined;
let dbClosed = false;
let closing: Promise<void> | undefined;

function release() {
  process.off("SIGINT", shutdown);
  process.off("SIGTERM", shutdown);
  process.stdin.off("end", shutdown);
  if (db && !dbClosed) {
    dbClosed = true;
    db.close();
  }
}

function stop(): Promise<void> {
  closing ??= (async () => {
    try { await server?.close(); } finally { release(); }
  })();
  return closing;
}

function shutdown() {
  void stop().catch(() => {
    process.stderr.write("MCP shutdown failed.\n");
    process.exitCode = 1;
  });
}

try {
  db = openDb(configuredDb === ":memory:" ? configuredDb : resolve(repositoryRoot, configuredDb));
  server = createResearchMcpServer({ db, client: createPublicClient(), now: () => new Date(),
    defaultStrategyPath: resolve(repositoryRoot, "config/strategies/volume-flow.example.json") });
  server.server.onclose = release;
  server.server.onerror = () => {
    process.stderr.write("MCP transport failed.\n");
    shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  await server.connect(new StdioServerTransport());
} catch {
  try { await stop(); } catch { /* No raw startup or cleanup diagnostics. */ }
  process.stderr.write("MCP startup failed.\n");
  process.exitCode = 1;
}
