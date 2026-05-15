# backend/src/server

Named backend bootstrap helpers used by `index.ts` after process guards are installed.

- `config.ts` — computes `PORT`, default project root, and `BACKEND_ORIGIN`.
- `app.ts` — builds the Express app, mounts middleware/routes, and installs the global JSON error middleware last.
- `http.ts` — creates the HTTP server and attaches the WS dispatcher.
- `startup.ts` — boot ordering: fire-and-forget harness detection, `ensureTerminalServer()`, `recoverOrphanedTasks()`, `listen()`, then `resumeInterruptedMergeRuns()` after the API is reachable.
