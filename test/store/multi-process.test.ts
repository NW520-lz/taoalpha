import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/store/db.ts";

type WorkerMessage = { kind: string; changes?: number; message?: string };

function messages(child: ChildProcess) {
  const pending: WorkerMessage[] = [];
  const waiters = new Map<string, (message: WorkerMessage) => void>();
  child.on("message", (message: WorkerMessage) => {
    if (message.kind === "error") {
      const problem = new Error(`worker failed: ${message.message}`);
      for (const resolve of waiters.values()) resolve({ kind: "error", message: problem.message });
      waiters.clear();
      pending.push(message);
      return;
    }
    const resolve = waiters.get(message.kind);
    if (resolve) {
      waiters.delete(message.kind);
      resolve(message);
    } else pending.push(message);
  });
  return (kind: string): Promise<WorkerMessage> => {
    const existing = pending.findIndex((message) => message.kind === kind || message.kind === "error");
    if (existing >= 0) {
      const [message] = pending.splice(existing, 1);
      if (message?.kind === "error") return Promise.reject(new Error(message.message));
      return Promise.resolve(message!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(kind);
        reject(new Error(`timed out waiting for ${kind}`));
      }, 6000);
      waiters.set(kind, (message) => {
        clearTimeout(timer);
        if (message.kind === "error") reject(new Error(message.message));
        else resolve(message);
      });
    });
  };
}

test("two processes serialize a card reservation and cannot create a second intent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "taoalpha-sqlite-lock-"));
  const tempRoot = realpathSync(tmpdir());
  const resolved = realpathSync(directory);
  const withinTemp = relative(tempRoot, resolved);
  assert.ok(withinTemp && !withinTemp.startsWith("..") && !isAbsolute(withinTemp));

  const path = join(directory, "shared.db");
  const db = openDb(path);
  db.exec("CREATE TABLE test_intents (card_id TEXT PRIMARY KEY)");
  const worker = fileURLToPath(new URL("../helpers/sqlite-lock-worker.ts", import.meta.url));
  const holder = fork(worker, [path, "holder"], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const contender = fork(worker, [path, "contender"], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => {
    const exited = [holder, contender].map((child) =>
      child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit"),
    );
    holder.kill();
    contender.kill();
    await Promise.all(exited);
    db.close();
    rmSync(resolved, { recursive: true, force: true });
  });

  const holderMessage = messages(holder);
  const contenderMessage = messages(contender);
  await Promise.all([holderMessage("ready"), contenderMessage("ready")]);
  holder.send("lock");
  await holderMessage("locked");
  contender.send("go");
  await contenderMessage("attempted");

  const result = contenderMessage("result");
  const stateWhileLocked = await Promise.race([
    result.then(() => "finished"),
    new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 150)),
  ]);
  assert.equal(stateWhileLocked, "waiting", "the second process must wait for the first writer");

  holder.send("release");
  await holderMessage("committed");
  assert.equal((await result).changes, 0, "the same card cannot create a second intent");
  assert.deepEqual(db.prepare("SELECT card_id FROM test_intents").all().map((row) => row.card_id), ["card_1"]);
});
