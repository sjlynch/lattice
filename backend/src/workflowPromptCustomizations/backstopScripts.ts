// Backstop scripts for the workflow-prompt-customization session. The
// customization /complete endpoint expects a JSON body `{prompt: <text>}`
// (an empty prompt marks the request `errored`), so unlike the task / merge
// / post-merge sites we cannot just curl an empty POST as the backstop.
//
// Two scripts cover the two harness backstop paths:
//
//   1. `lattice-customization-backstop.cjs`: a small CJS helper run by the
//      Claude Stop hook. Mirrors `submit-customized-prompt.cjs` (best-case
//      success) but is fail-soft — if `CUSTOMIZED_PROMPT.md` doesn't exist
//      or can't be read, it still POSTs (with an empty prompt + an
//      `?error=` query string) so the request transitions to `errored`
//      instead of hanging in `running` forever. The Stop hook calls this
//      via `node lattice-customization-backstop.cjs`.
//
//   2. The Pi extension itself — handled by `piExtension.ts`'s `promptFile`
//      mode (reads the file at shutdown and POSTs it as JSON). The Pi
//      extension also writes a sentinel record for diagnostics.

export function renderCustomizationBackstopScript(callbackUrl: string): string {
  return `#!/usr/bin/env node
// Lattice-managed — do not commit. Backstop for the workflow-prompt-
// customization callback, invoked by the Claude Stop hook in this
// directory's .claude/settings.local.json. Mirrors the success path of
// submit-customized-prompt.cjs but never throws — a missing file produces
// an explicit error POST so the request leaves the 'running' state.
const fs = require("node:fs");
const path = require("node:path");

const URL = ${JSON.stringify(callbackUrl)};
const PROMPT_FILE = path.join(__dirname, "CUSTOMIZED_PROMPT.md");
const ATTEMPT_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 400;

function appendSource(url, source, error) {
  let out = url + (url.includes("?") ? "&" : "?") + "source=" + encodeURIComponent(source);
  if (error) out += "&error=" + encodeURIComponent(error);
  return out;
}

function readPromptOrNull() {
  try {
    return fs.readFileSync(PROMPT_FILE, "utf8");
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

async function attemptPost(url, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postWithRetries(url, body) {
  const attempts = [];
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const result = await attemptPost(url, body);
    attempts.push(result);
    if (result.ok) return { success: true, attempts };
    if (i < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS * (i + 1)));
    }
  }
  return { success: false, attempts };
}

async function main() {
  const read = readPromptOrNull();
  let url;
  let body;
  if (typeof read === "string") {
    url = appendSource(URL, "claude-stop-hook-workflow-customization-complete");
    body = { prompt: read };
  } else {
    url = appendSource(
      URL,
      "claude-stop-hook-workflow-customization-complete",
      "missing-or-unreadable-CUSTOMIZED_PROMPT.md: " + read.error,
    );
    // Empty prompt → /complete will mark the request 'errored'. That is
    // the correct surfaced state when the model never wrote the file.
    body = { prompt: "" };
  }
  const { success, attempts } = await postWithRetries(url, body);
  if (!success) {
    // Stop hooks don't surface stderr in any user-visible way, but log
    // for the rare case where someone tails the dev server.
    console.error(
      "[lattice-customization-backstop] all " +
        MAX_ATTEMPTS +
        " POST attempts failed: " +
        JSON.stringify(attempts),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;
}
