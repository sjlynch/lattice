// Shared renderer + installer for Pi's `.pi/extensions/lattice-complete.ts`
// completion backstop. Replaces the three near-identical inline renderers
// previously inlined in worktree/stopHook.ts, postMergeHooks/stopHook.ts,
// and workflowRuns/stepSpawner.ts so all backstops get the same hardening
// in one place:
//
//   1. Configurable shutdown-reason gate. The original snippet only fired
//      on `reason === 'quit'` to avoid flipping a task on `/new`, `/reload`,
//      `/fork` — for sites with a kill-by-cwd side effect this is right;
//      for sites without it (workflow steps, post-merge hooks, prompt
//      customization) we accept any shutdown reason so abnormal exits
//      still produce a callback.
//   2. A short timeout on the POST so a wedged backend doesn't strand
//      session_shutdown.
//   3. A small retry loop so a transient socket / DNS hiccup during
//      shutdown isn't immediately fatal.
//   4. A sentinel file written next to the extension that records the
//      reason, attempt count, outcome, and any error message. Lets us
//      diagnose Pi-side reliability issues without server-side guessing —
//      "did the extension fire? did the POST succeed?" is now visible
//      on disk.
//   5. Optional `promptFile` mode for the prompt-customization endpoint:
//      reads the file the model wrote and POSTs it as JSON `{prompt}`.
//
// Adding a new Pi-extension call-site = add a `PiExtensionSite` value,
// pick a sentinel filename, decide whether to gate on `quit`, and call
// `installPiCompletionExtension`. Don't inline a fresh copy.

import path from 'node:path';
import fs from 'node:fs/promises';

export type PiExtensionSite =
  | 'task-complete'
  | 'workflow-step-complete'
  | 'post-merge-hook-complete'
  | 'workflow-customization-complete';

export type PiCompletionExtensionOptions = {
  callbackUrl: string;
  /** Which call-site this extension serves. Tagged in the URL + sentinel for log correlation. */
  site: PiExtensionSite;
  /**
   * When `true`, only fire on `event.reason === 'quit'` (or unset). Use for
   * sites whose callback has a destructive side effect — currently only the
   * task `/complete` endpoint, which schedules a kill-by-cwd 1s later and
   * would yank a `/fork`'d pty out from under an interactive user.
   * Other sites should set this to `false` so abnormal-exit reasons still
   * trigger the callback.
   */
  respectQuitGate: boolean;
  /**
   * If provided (absolute path), read this file at shutdown and POST its
   * contents as JSON `{prompt: <contents>}`. Used by the workflow
   * prompt-customization backstop. Otherwise POSTs an empty body.
   */
  promptFile?: string;
  /** Absolute path to the extension `.ts` file. */
  extensionFile: string;
  /** Absolute path to the sentinel `.json` audit log written next to the extension. */
  sentinelFile: string;
};

// Filename for the per-site sentinel (lives alongside the extension under
// `.pi/extensions/`). Pi auto-loads any `.ts` in that dir, so we keep the
// sentinel as `.json` so it isn't itself executed as an extension.
export function defaultPiSentinelFileName(): string {
  return 'lattice-last-shutdown.json';
}

export function defaultPiExtensionFileName(): string {
  return 'lattice-complete.ts';
}

// Render the extension source. Strings are kept as JSON literals so an
// unexpected character in a URL or path can't break the generated TS.
export function renderPiCompletionExtension(
  opts: PiCompletionExtensionOptions,
): string {
  const { callbackUrl, site, respectQuitGate, promptFile, sentinelFile } = opts;
  // Append ?source so the backend `/complete` route can log which mechanism
  // fired (model curl vs Pi extension vs Claude Stop hook).
  const urlWithSource = appendSourceParam(callbackUrl, `pi-extension-${site}`);
  const promptFileLiteral = promptFile ? JSON.stringify(promptFile) : 'null';

  return `// Lattice-managed — do not commit. Reports completion (${site}) to Lattice
// when the Pi session exits. Mirrors the Claude Stop hook installed alongside
// this directory. Safe to fire multiple times — the Lattice endpoint is
// idempotent. Writes a sentinel JSON file beside this extension recording
// what happened so we can diagnose Pi reliability without server logs.
//
// Hardened behavior vs. the original one-shot fetch:
//   - up to 3 attempts with a short backoff so a transient socket hiccup
//     during process shutdown doesn't lose the callback;
//   - a per-attempt timeout so a wedged backend doesn't strand shutdown;
//   - a sentinel audit log so 'did the extension fire?' is visible on disk;
//   - shutdown-reason gate is ${respectQuitGate ? 'enabled' : 'disabled'}
//     for this site (${site}).

import fs from "node:fs";

const CALLBACK_URL = ${JSON.stringify(urlWithSource)};
const SENTINEL_FILE = ${JSON.stringify(sentinelFile)};
const PROMPT_FILE = ${promptFileLiteral};
const SITE = ${JSON.stringify(site)};
const RESPECT_QUIT_GATE = ${respectQuitGate ? 'true' : 'false'};
const ATTEMPT_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 400;

function writeSentinel(record) {
  try {
    fs.writeFileSync(SENTINEL_FILE, JSON.stringify(record, null, 2));
  } catch {
    // Best-effort — sentinel write must never throw out of session_shutdown.
  }
}

function readPromptIfNeeded() {
  if (!PROMPT_FILE) return { prompt: undefined, promptError: undefined };
  try {
    const prompt = fs.readFileSync(PROMPT_FILE, "utf8");
    return { prompt, promptError: undefined };
  } catch (err) {
    return { prompt: "", promptError: String(err && err.message ? err.message : err) };
  }
}

async function attemptPost(prompt) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const init = {
      method: "POST",
      signal: ac.signal,
    };
    if (prompt !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify({ prompt });
    }
    const res = await fetch(CALLBACK_URL, init);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postWithRetries(prompt) {
  const attempts = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attemptPost(prompt);
    attempts.push(result);
    if (result.ok) return { success: true, attempts };
    if (i < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS * (i + 1)));
    }
  }
  return { success: false, attempts };
}

export default function (pi) {
  pi.on("session_shutdown", async (event) => {
    const reason = event && event.reason ? event.reason : undefined;
    const startedAt = Date.now();

    if (RESPECT_QUIT_GATE && reason && reason !== "quit") {
      writeSentinel({
        site: SITE,
        startedAt,
        reason,
        skipped: "non-quit reason gated by RESPECT_QUIT_GATE",
      });
      return;
    }

    const { prompt, promptError } = readPromptIfNeeded();
    const { success, attempts } = await postWithRetries(prompt);

    writeSentinel({
      site: SITE,
      startedAt,
      finishedAt: Date.now(),
      reason,
      url: CALLBACK_URL,
      promptFile: PROMPT_FILE,
      promptError,
      promptBytes: prompt === undefined ? null : prompt.length,
      attempts,
      success,
    });
  });
}
`;
}

function appendSourceParam(url: string, source: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}source=${encodeURIComponent(source)}`;
}

// Install (or update) the Pi extension on disk. Skips the write when the
// existing contents already match so a worktree reconciliation doesn't dirty
// `git status`.
export async function installPiCompletionExtension(args: {
  dir: string;
  callbackUrl: string;
  site: PiExtensionSite;
  respectQuitGate: boolean;
  promptFile?: string;
}): Promise<{ extensionFile: string; sentinelFile: string }> {
  const extDir = path.join(args.dir, '.pi', 'extensions');
  await fs.mkdir(extDir, { recursive: true });
  const extensionFile = path.join(extDir, defaultPiExtensionFileName());
  const sentinelFile = path.join(extDir, defaultPiSentinelFileName());
  const expected = renderPiCompletionExtension({
    callbackUrl: args.callbackUrl,
    site: args.site,
    respectQuitGate: args.respectQuitGate,
    promptFile: args.promptFile,
    extensionFile,
    sentinelFile,
  });
  try {
    const existing = await fs.readFile(extensionFile, 'utf8');
    if (existing === expected) return { extensionFile, sentinelFile };
  } catch {
    /* file absent — fall through to write */
  }
  await fs.writeFile(extensionFile, expected, 'utf8');
  console.log(
    `[pi-extension] installed ${args.site} backstop at ${extensionFile} ` +
      `(gate=${args.respectQuitGate ? 'quit-only' : 'any-reason'}` +
      `${args.promptFile ? `, promptFile=${args.promptFile}` : ''})`,
  );
  return { extensionFile, sentinelFile };
}

// Helper for callers that want to read a sentinel for diagnostics (e.g. the
// staleness sweep in recovery/inProgressSweep.ts could surface it on the
// task card). Returns null if absent / unparseable.
export async function readPiShutdownSentinel(
  scratchDir: string,
): Promise<unknown | null> {
  try {
    const file = path.join(
      scratchDir,
      '.pi',
      'extensions',
      defaultPiSentinelFileName(),
    );
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
