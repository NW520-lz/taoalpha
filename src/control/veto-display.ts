import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type VetoCardView = { title: string; lines: string[]; seconds: number };
export type VetoDisplayResult = 'rejected' | 'elapsed' | 'unavailable';
type Runner = (input: string, onLine: (line: string) => void) => Promise<void>;

/** Runs the local window script; the card goes through stdin, never through arguments or files. */
function runNativeWindow(input: string, onLine: (line: string) => void): Promise<void> {
 const script = fileURLToPath(new URL('./veto-window.ps1', import.meta.url));
 return new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, i).trim()); buffer = buffer.slice(i + 1); } });
  child.on('error', reject);
  child.on('close', () => { if (buffer.trim()) onLine(buffer.trim()); resolve(); });
  child.stdin.end(input, 'utf8');
 });
}

/**
 * ADR-012 local display. `onShown` runs only after the window reports it is on screen, so the backend can start
 * the veto window then. Closing the window counts as a rejection (it only lowers risk); a window that never
 * reports being shown, a failed process or unreadable output is `unavailable`, and such a card must not execute.
 */
export function createVetoDisplay(options: { platform?: NodeJS.Platform; run?: Runner } = {}) {
 const platform = options.platform ?? process.platform, run = options.run ?? runNativeWindow;
 return {
  async show(card: VetoCardView, onShown: () => void): Promise<VetoDisplayResult> {
   if (platform !== 'win32') return 'unavailable';
   let shown = false, outcome: VetoDisplayResult | null = null, broken = false;
   try {
    await run(JSON.stringify(card), (line) => {
     if (outcome || broken || !line) return;
     let event: unknown;
     try { event = (JSON.parse(line) as { event?: unknown }).event; } catch { broken = true; return; }
     if (event === 'shown' && !shown) { shown = true; onShown(); }
     else if (shown && (event === 'rejected' || event === 'closed')) outcome = 'rejected';
     else if (shown && event === 'elapsed') outcome = 'elapsed';
     else broken = true;
    });
   } catch { return 'unavailable'; }
   return !broken && outcome ? outcome : 'unavailable';
  },
 };
}
