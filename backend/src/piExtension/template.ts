// Source template for Pi's `.pi/extensions/lattice-complete.ts` completion
// backstop. This module owns *how the extension text is assembled* and nothing
// else — no filesystem I/O. `../piExtension.ts` composes
// `renderPiCompletionExtension` from the pieces here; `install.ts` writes the
// result to disk.
//
// The generated text is byte-for-byte significant: the Pi runtime loads it
// verbatim and the on-disk up-to-date check compares it character for
// character. Reorganize the *assembly* freely, but never change the produced
// string. The template is split into clear sections —
//
//   - `renderHeaderComment`     the banner comment (varies by site + gate)
//   - `buildExtensionConstants` the `const` declaration block
//   - `EXTENSION_HELPERS`       writeSentinel / readPromptIfNeeded /
//                               attemptPost / postWithRetries
//   - `EXTENSION_DEFAULT_HANDLER` the `session_shutdown` handler
//
// — and `renderExtensionSource` joins them with the exact blank-line spacing
// the original single template literal produced.

// Append ?source so the backend `/complete` route can log which mechanism
// fired (model curl vs Pi extension vs Claude Stop hook).
export function appendSourceParam(url: string, source: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}source=${encodeURIComponent(source)}`;
}

// The banner comment at the top of the extension. The only varying parts are
// the call-site label and whether the shutdown-reason gate is described as
// enabled or disabled.
export function renderHeaderComment(opts: {
  site: string;
  respectQuitGate: boolean;
}): string {
  const { site, respectQuitGate } = opts;
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
//     for this site (${site}).`;
}

// The `const` declaration block. Strings are emitted as JSON literals so an
// unexpected character in a URL or path can't break the generated TS.
export function buildExtensionConstants(opts: {
  urlWithSource: string;
  sentinelFile: string;
  promptFileLiteral: string;
  site: string;
  respectQuitGate: boolean;
}): string {
  const { urlWithSource, sentinelFile, promptFileLiteral, site, respectQuitGate } =
    opts;
  return `const CALLBACK_URL = ${JSON.stringify(urlWithSource)};
const SENTINEL_FILE = ${JSON.stringify(sentinelFile)};
const PROMPT_FILE = ${promptFileLiteral};
const SITE = ${JSON.stringify(site)};
const RESPECT_QUIT_GATE = ${respectQuitGate ? 'true' : 'false'};
const ATTEMPT_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 400;`;
}

// The helper functions, fully static (they reference the constants above by
// name at runtime, so nothing here is interpolated).
export const EXTENSION_HELPERS = `function writeSentinel(record) {
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
}`;

// The default export installed on the Pi instance — the `session_shutdown`
// handler. Also fully static.
export const EXTENSION_DEFAULT_HANDLER = `export default function (pi) {
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
}`;

// Assemble the full extension source from the sections above, preserving the
// exact blank-line spacing the original single template literal produced
// (one blank line between every section, a trailing newline at the end).
export function renderExtensionSource(opts: {
  urlWithSource: string;
  sentinelFile: string;
  promptFileLiteral: string;
  site: string;
  respectQuitGate: boolean;
}): string {
  const { urlWithSource, sentinelFile, promptFileLiteral, site, respectQuitGate } =
    opts;
  const sections = [
    renderHeaderComment({ site, respectQuitGate }),
    'import fs from "node:fs";',
    buildExtensionConstants({
      urlWithSource,
      sentinelFile,
      promptFileLiteral,
      site,
      respectQuitGate,
    }),
    EXTENSION_HELPERS,
    EXTENSION_DEFAULT_HANDLER,
  ];
  return `${sections.join('\n\n')}\n`;
}
