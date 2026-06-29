# backend/src/server

Named backend bootstrap helpers used by `index.ts` after process guards are installed.

- `config.ts` — computes `PORT`, default project root, and `BACKEND_ORIGIN`.
- `app.ts` — builds the Express app, mounts middleware/routes, and installs the global JSON error middleware last.
- `http.ts` — creates the HTTP server and attaches the WS dispatcher.
- `startup.ts` — boot ordering / invariants:
  1. fire-and-forget harness detection plus best-effort Pi setup
     (`ensurePiSubagentsInstalled()` and `reconcilePiModelsJson()`); these must
     never block listen or throw out of startup;
  2. `ensureTerminalServer()` before any recovery can spawn/resume terminals;
  3. `startSpawnQueue()` to prime terminal-session accounting;
  4. `recoverOrphanedTasks()` while the API is still closed;
  5. `listen()` on `127.0.0.1` only (not `localhost`, not LAN-visible);
  6. after the API is reachable, `resumeInterruptedMergeRuns()` and
     `resumeQueuedTaskRuns()` so spawned agents can call back;
  7. start the periodic in-progress sweep (`startInProgressSweepLoop()`).
