import { openDb, inTransaction } from "../../src/store/db.ts";

const [path, role] = process.argv.slice(2);
if (!path || (role !== "holder" && role !== "contender")) {
  throw new Error("sqlite-lock-worker requires a database path and holder|contender role");
}

const db = openDb(path);
process.send?.({ kind: "ready" });

process.on("message", (command: unknown) => {
  try {
    if (role === "holder" && command === "lock") {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT OR IGNORE INTO test_intents (card_id) VALUES (?)").run("card_1");
      process.send?.({ kind: "locked" });
    } else if (role === "holder" && command === "release") {
      db.exec("COMMIT");
      process.send?.({ kind: "committed" }, () => {
        db.close();
        process.disconnect?.();
      });
    } else if (role === "contender" && command === "go") {
      process.send?.({ kind: "attempted" });
      const changes = inTransaction(db, () =>
        db.prepare("INSERT OR IGNORE INTO test_intents (card_id) VALUES (?)").run("card_1").changes,
      );
      process.send?.({ kind: "result", changes: Number(changes) }, () => {
        db.close();
        process.disconnect?.();
      });
    } else {
      throw new Error(`unexpected ${role} command: ${String(command)}`);
    }
  } catch (error) {
    process.send?.({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    db.close();
    process.exitCode = 1;
  }
});
