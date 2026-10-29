import { runDemoCheck } from "./demo-check.ts";

const result = await runDemoCheck(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
