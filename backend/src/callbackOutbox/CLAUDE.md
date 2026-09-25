# backend/src/callbackOutbox

Durable delivery for agent **completion callbacks** — the POST a Claude Stop
hook, a Codex `Stop` hook or the Pi `session_shutdown` extension makes to
`/api/tasks/:id/complete`, `/api/workflow-runs/:runId/steps/:n/complete`,
`/api/post-merge-hooks/:id/complete`, `/api/push-runs/:id/done`,
`/api/qa-runs/:id/done`, ….

## Why

Those callbacks used to be one `curl -s -m 5` (Pi: three tries in ~1.2 s).
When Lattice works on its own repo, every merge that touches `backend/src`
restarts the backend; a Stop that fired inside that window was simply gone.
The task sat `in_progress` beside an idle terminal forever (the in-progress
sweep only acts on a DEAD pty, and an interactive Claude stays alive after its
turn), and a re-adopted workflow agent step never advanced. Agent ptys live in
the detached terminal-server and survive the restart — only the one message
that says "I'm done" was lost.

## How

1. **Hook side** — `script.ts` renders `~/.lattice/bin/lattice-callback.cjs`
   (plain CommonJS, no deps; regenerated at boot and on every hook install, so
   it always matches this backend). Every Claude Stop hook
   (`claudeStopHook.ts`) and Codex Stop hook (`codexStopHook.ts`) runs
   `node <script> <url>`. The script writes an outbox entry FIRST, then POSTs
   with retries for `CALLBACK_HOOK_BUDGET_MS` (45 s); a definitive answer (2xx,
   or a 4xx other than 408/429) removes the entry. It always exits 0 and
   prints nothing — a Stop hook's output/exit code is interpreted by the
   harness. The Pi extension (`piExtension/template.ts`) writes and clears the
   same entry around its own retry loop.
2. **Backend side** — `drain.ts` `startCallbackOutboxLoop` (started post-listen
   in `server/startup.ts`, every 10 s) replays each entry by POSTing it back to
   this backend's own origin, so it goes through the same route, validation
   and idempotency guards as a live callback. 5xx / network → kept with
   exponential backoff (≤ 60 s); definitive → removed.

## Invariants

- **One entry per callback URL** (`paths.ts` `callbackOutboxKey`, sha1[:20]).
  A Claude Stop fires on every turn end, so repeats collapse into the newest
  one. The generated script and the Pi extension compute the same key — keep
  them in step.
- **`holdUntil`**: the drain leaves an entry alone while the hook that wrote
  it may still be retrying, so the two never deliver concurrently.
- **Only our own API is replayed** (`isReplayableUrl`: same origin, `/api/`
  path). The outbox is a plain directory; its contents are never "POST
  wherever this says". An entry for another origin is left in place (another
  Lattice instance sharing this home on a different port drains its own) until
  the age cap drops it.
- **Late replay is safe** because every target endpoint is idempotent, and
  because the terminal WS is relayed *through* the backend — nobody can type
  into an agent while the backend is down, so an agent whose Stop was lost is
  still idle at the end of that turn when the replay lands. Entries older than
  24 h (`OUTBOX_MAX_AGE_MS`) are dropped.
- **Fallbacks**: the Claude command is `node "<script>" "<url>" || <retrying
  curl>` — the curl only runs when node can't run the script at all. Codex
  whitespace-splits its hook command with no shell, so a script path containing
  whitespace falls back to the retrying curl there (`codexCallbackCommands`).
- The model-explicit completion curls in the briefs (`LATTICE_TASK.md`,
  `WORKFLOW_STEP.md`, merge / QA / post-merge / stash templates) carry
  `--retry … --retry-connrefused` for the same reason; they have no outbox.

Tests: `__tests__/callbackOutbox.test.ts` runs the real generated script and
the real generated Pi extension against a local HTTP server (delivered,
retry-then-keep, backend down → kept → drained) plus the drain's policy.
