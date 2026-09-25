# backend/src/server

Named backend bootstrap helpers used by `index.ts` after process guards are installed.

- `config.ts` — computes `PORT` (`backendPort()`), default project root
  (`LATTICE_DEFAULT_ROOT` overrides it — the isolated e2e instance uses a
  scratch dir), and `BACKEND_ORIGIN`.
- `bootGuards.ts` — `runBootGuards()`, awaited at the very top of `index.ts`
  (before `installProcessGuards`, i.e. before crash-log adoption, Pi setup, the
  terminal-server handshake and recovery). Refuses — message + exit 1 — when
  the backend's code dir or cwd is inside a `.lattice/worktrees/` checkout
  (override `LATTICE_ALLOW_WORKTREE_BACKEND=1`, only with an isolated HOME and
  ports), and when the port is already held: a throwaway bind on
  `127.0.0.1:PORT` (ms, unlike a connect probe that Windows takes ~2 s to
  refuse), then `/api/health` names a live Lattice backend vs a foreign holder.
  Check-then-recover, not a held claim: `listen()` still happens after
  recovery, so two backends started within the same few seconds are not
  caught — a stray one started beside a long-running live one is. Imports only
  node builtins. Tests: `__tests__/bootGuards.test.ts`.
- `app.ts` — builds the Express app, mounts middleware/routes, and installs the global JSON error middleware last.
  The first routers mounted are the restart-drain admission gate (new
  workflow / merge / task / push / QA starts answer 503 `backend-restarting`
  while the dev runner prepares a restart) and the token-guarded
  `/api/internal/restart-drain/*` handshake — see `../restartDrain/CLAUDE.md`.
  Known request-body parser errors retain their 4xx status and return actionable
  JSON. Their log includes bounded route metadata only: the parser error's body
  and message may contain private or very large submitted summaries. Express's
  own 4xx client errors (e.g. an undecodable `:param` percent-escape → 400)
  keep their status the same way, unless they set `expose: false`. Unexpected
  route failures still log the error and return 500; sent headers delegate to
  Express's final handler.
- `http.ts` — creates the HTTP server and attaches the WS dispatcher.
- `startup.ts` — boot ordering / invariants:
  1. fire-and-forget harness detection plus best-effort Pi setup
     (`ensurePiSubagentsInstalled()`, `ensurePiMcpInstalled()`, and
     `reconcilePiModelsJson()`); these must never block listen or throw out of
     startup;
  2. `ensureTerminalServer()` before any recovery can spawn/resume terminals;
  3. `startSpawnQueue()` to prime terminal-session accounting;
  4. `recoverOrphanedTasks()` while the API is still closed;
  5. `listen()` on `127.0.0.1` only (not `localhost`, not LAN-visible);
  6. after the API is reachable, `resumeInterruptedWorkflowRuns()` and THEN
     `resumeInterruptedMergeRuns()` (a resumed workflow owns its project's merge
     pipeline, so the merge-run resume skips projects with an active workflow
     run), plus `resumeQueuedTaskRuns()`, so spawned agents can call back. The
     `/api/workflows/:id/run` + `/api/workflow-runs` routes answer 503
     `workflow-recovering` until the workflow resume settles;
  7. start the periodic in-progress sweep (`startInProgressSweepLoop()`), the
     terminal-tab registry watch (`startTerminalRegistryWatch()`), and the
     completion-callback outbox replay (`ensureCallbackScript()` +
     `startCallbackOutboxLoop()` — callbacks a Stop hook couldn't deliver
     while this process was down; see `../callbackOutbox/CLAUDE.md`).
