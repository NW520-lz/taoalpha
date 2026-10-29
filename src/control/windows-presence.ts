export interface WindowsReviewInput {
  readonly subject: unknown;
  readonly subjectHash: string;
  readonly challenge: string;
  readonly expiresAt: string;
}

/** Internal backend dependency injection. Never accept worker implementations from request bodies. */
export function createWindowsPresence(options: {
  platform?: NodeJS.Platform;
  runWorker?: (mode: "Check" | "Review", input?: string, timeoutMs?: number) => Promise<string>;
  now?: () => Date;
} = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.runWorker ?? runNativeWorker;
  const clock = options.now ?? (() => new Date());
  return {
    async availability(): Promise<{ status: "available" | "unavailable" }> {
      if (platform !== "win32") return { status: "unavailable" };
      try {
        const parsed = z.object({ status: z.enum(["available", "unavailable"]) }).strict().parse(JSON.parse(await run("Check", undefined, 10_000)));
        return { status: parsed.status };
      } catch { return { status: "unavailable" }; }
    },
    async reviewAndVerify(input: WindowsReviewInput): Promise<{ status: "verified" | "denied" | "unavailable" | "timeout" }> {
      if (platform !== "win32") return { status: "unavailable" };
      try {
        const deadline = Date.parse(input.expiresAt);
        const nowMs = clock().getTime();
        if (!Number.isFinite(deadline) || !Number.isFinite(nowMs)) return { status: "unavailable" };
        if (deadline <= nowMs) return { status: "timeout" };
        if (!/^[a-f0-9]{64}$/.test(input.subjectHash) || !/^[a-f0-9]{64}$/.test(input.challenge) ||
          !input.subject || typeof input.subject !== "object" || Array.isArray(input.subject) || hashJson(input.subject) !== input.subjectHash) return { status: "unavailable" };
        const displayText = canonicalJson(input.subject);
        if (Buffer.byteLength(displayText, "utf8") > 65536) return { status: "unavailable" };
        const request = JSON.stringify({ displayText, subjectHash: input.subjectHash, challenge: input.challenge, expiresAt: input.expiresAt });
        const raw = await run("Review", request, Math.min(deadline - nowMs, 180_000));
        const result = z.object({ status: z.enum(["verified", "denied", "unavailable", "timeout"]), challenge: z.string() }).strict().parse(JSON.parse(raw));
        if (result.challenge !== input.challenge) return { status: "unavailable" };
        const completedAt = clock().getTime();
        if (!Number.isFinite(completedAt)) return { status: "unavailable" };
        if (completedAt >= deadline) return { status: "timeout" };
        return { status: result.status };
      } catch { return { status: "unavailable" }; }
    },
  };
}
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, hashJson } from "../lib/hash.ts";


/** Fixed local worker only. Subject content travels over private stdin, never command arguments/logs. */
function runNativeWorker(mode: "Check" | "Review", input?: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = fileURLToPath(new URL("./windows-presence.ps1", import.meta.url));
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script, "-Mode", mode], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error("Native confirmation worker unavailable"));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 131072) { child.kill(); finish(false); } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(input ?? "");
  });
}
