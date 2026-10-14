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
// It also re-prompts (twice at most) after a reply cut off at the output limit
// or one whose tool call the model wrote as plain text: either ends the turn
// mid-work with nothing run.
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

// A tool call written as plain text (a local model's chat template leaking
// `<tool_call>` / `<function=…>` markup) ends the turn with nothing run; the
// session then sits idle, or a print-mode run exits "done". Nudge it to call
// the tool properly, at most twice in a row.
export const PI_MALFORMED_TOOL_CALL_PATTERN = /<tool_call>|<function=[^>]*>|<\/parameter>/;
export const PI_MALFORMED_MAX = 2;
export const PI_MALFORMED_PROMPT =
  'Your last message contained a tool call written as plain text, so it was not executed. Call the tool again using the proper tool-calling format.';
// A reply cut off at the model's output limit (stopReason "length") likewise
// ends the turn mid-work and leaves the session idle; it shares the cap.
export const PI_LENGTH_PROMPT =
  'Your last reply was cut off at the output limit. Continue where you left off; split large edits or files into smaller steps.';

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
const MALFORMED = ${PI_MALFORMED_TOOL_CALL_PATTERN.toString()};
const MAX_MALFORMED_NUDGES = ${PI_MALFORMED_MAX};
const MALFORMED_PROMPT = ${JSON.stringify(PI_MALFORMED_PROMPT)};
const LENGTH_PROMPT = ${JSON.stringify(PI_LENGTH_PROMPT)};

export default function (pi) {
  let attempts = 0;
  let lastError = null;
  let nudge = null;
  let malformedNudges = 0;
  let timer = null;
  pi.on("agent_end", (event) => {
    const messages = Array.isArray(event && event.messages) ? event.messages : [];
    let last = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "assistant") { last = messages[i]; break; }
    }
    lastError = last && last.stopReason === "error" ? String(last.errorMessage || "") : null;
    if (!lastError) attempts = 0;
    // A tool call the model wrote as plain text ends the turn without running it.
    const content = last && Array.isArray(last.content) ? last.content : [];
    const text = content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\\n");
    const malformed = !lastError && !content.some((c) => c && c.type === "toolCall") && MALFORMED.test(text);
    nudge = lastError ? null : last && last.stopReason === "length" ? LENGTH_PROMPT : malformed ? MALFORMED_PROMPT : null;
    if (!nudge) malformedNudges = 0;
  });
  pi.on("agent_settled", () => {
    if (nudge && malformedNudges < MAX_MALFORMED_NUDGES) {
      const text = nudge;
      nudge = null;
      malformedNudges += 1;
      pi.sendUserMessage(text);
      return;
    }
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
