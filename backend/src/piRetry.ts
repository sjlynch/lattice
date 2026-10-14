// Pi transient-error continuation for Lattice-spawned (unattended) Pi sessions.
//
// Pi retries a failed model request only when the error text matches its own
// provider patterns (429/5xx/"overloaded"/"timeout"…). A local
// OpenAI-compatible server's admission-queue expiry ("inference request
// expired while waiting for admission") or a model still loading matches none
// of them, so the turn ends with stopReason "error" and the session sits idle
// at its prompt: the task or workflow step never finishes. The generated
// `<dir>/.pi/extensions/lattice-retry.ts` sends a "continue" after such an
// error, with backoff and a cap, once Pi has settled (its own retries done).
// Never installed for the user's own project-root Pi (no surprise input there).

import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteFile } from './fsAtomic.js';

export const PI_RETRY_EXTENSION_FILE = 'lattice-retry.ts';

// Error text worth continuing after: transient server-side states Pi's own
// retry pattern misses. Kept narrow — a real request error must still stop.
export const PI_CONTINUE_ERROR_PATTERN =
  /expired while waiting|admission|queue.?(?:full|timeout|timed)|model.{0,20}loading|loading model|temporar(?:il)?y unavailable|econnreset|epipe|socket hang up|fetch failed|terminated/i;
export const PI_CONTINUE_MAX = 6;
export const PI_CONTINUE_BASE_DELAY_MS = 10_000;
export const PI_CONTINUE_MAX_DELAY_MS = 120_000;
export const PI_CONTINUE_PROMPT =
  'The model server failed with a transient error before your last reply finished. Continue exactly where you left off.';

// The delay before continuation `attempt` (1-based): exponential, capped.
export function piContinueDelayMs(attempt: number): number {
  return Math.min(PI_CONTINUE_MAX_DELAY_MS, PI_CONTINUE_BASE_DELAY_MS * 2 ** (attempt - 1));
}

export function renderPiRetryExtension(): string {
  return `// Lattice-managed — do not commit. After a transient model-server error that
// Pi's own retry does not cover, continue this unattended session (backoff,
// at most ${PI_CONTINUE_MAX} times in a row) instead of leaving it idle at its prompt.

const PATTERN = ${PI_CONTINUE_ERROR_PATTERN.toString()};
const MAX_CONTINUES = ${PI_CONTINUE_MAX};
const BASE_DELAY_MS = ${PI_CONTINUE_BASE_DELAY_MS};
const MAX_DELAY_MS = ${PI_CONTINUE_MAX_DELAY_MS};
const PROMPT = ${JSON.stringify(PI_CONTINUE_PROMPT)};

export default function (pi) {
  let attempts = 0;
  let lastError = null;
  let timer = null;
  pi.on("agent_end", (event) => {
    const messages = Array.isArray(event && event.messages) ? event.messages : [];
    let last = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "assistant") { last = messages[i]; break; }
    }
    lastError = last && last.stopReason === "error" ? String(last.errorMessage || "") : null;
    if (!lastError) attempts = 0;
  });
  pi.on("agent_settled", () => {
    const err = lastError;
    lastError = null;
    if (!err || !PATTERN.test(err) || attempts >= MAX_CONTINUES) return;
    attempts += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pi.sendUserMessage(PROMPT); }, delay);
  });
  pi.on("session_shutdown", () => { if (timer) clearTimeout(timer); timer = null; });
}
`;
}

// Write (or refresh) `<dir>/.pi/extensions/lattice-retry.ts`; skips an identical
// file. Best-effort, like the activity extension: never fails a spawn.
export async function installPiRetryExtension(dir: string): Promise<void> {
  const file = path.join(dir, '.pi', 'extensions', PI_RETRY_EXTENSION_FILE);
  const expected = renderPiRetryExtension();
  try {
    try {
      if ((await fs.readFile(file, 'utf8')) === expected) return;
    } catch {
      /* absent — write it */
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, expected);
  } catch (err) {
    console.warn(`[pi-retry] could not install ${file}:`, err);
  }
}
