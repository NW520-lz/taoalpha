import { createPublicClient } from "./okx/public-client.ts";
import { openDb } from "./store/db.ts";
import { runCli } from "./cli.ts";

const DEFAULT_DB_PATH = "data/taoalpha.db";
const DEFAULT_STRATEGY_PATH = "config/strategies/volume-flow.example.json";

const db = openDb(process.env.TAOALPHA_DB ?? DEFAULT_DB_PATH);
try {
  const envelope = await runCli(process.argv.slice(2), {
    db,
    client: createPublicClient(),
    now: () => new Date(),
    defaultStrategyPath: DEFAULT_STRATEGY_PATH,
  });
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  if (!envelope.ok) process.exitCode = 1;
} finally {
  db.close();
}
