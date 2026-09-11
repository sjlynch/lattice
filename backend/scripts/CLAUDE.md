# Backend scripts

- `dev.mjs` is the backend dev-runner entrypoint. Keep it readable as: self-heal deps → initial compile/assets → start the compiled backend → supervise `tsc -w` and watch `dist/` → real shutdown.
- Focused helpers live under `backend/scripts/dev/`: dependency/npm helpers, compile/assets orchestration, run.lock restart deferral, dist watching, and backend/terminal lifecycle.
- `dev/deps.mjs` `selfHealDeps` is the second self-heal layer behind the root `scripts/preflight.mjs` (for when this runner is started on its own). Both use the shared `scripts/depsCheck.mjs`: every dep `backend/package.json` declares must be installed at the version `package-lock.json` pins. Keep it manifest-driven — a hand-picked `REQUIRED_PKGS` sample is how a pulled `@modelcontextprotocol/sdk` + `zod` addition sailed past the check and failed the initial `tsc` instead (2026-09-06).
- **`fs.watch('dist')` is not a "code changed" signal on Windows.** libuv arms `ReadDirectoryChangesW` with a filter that also covers ATTRIBUTES / LAST_ACCESS / CREATION / SECURITY, so an NTFS last-access flush (`fsutil behavior query disablelastaccess` = 0 on the affected machine → last-access updates enabled), an antivirus/indexer scan, or an ACL refresh fires it with nothing written. The runner used to restart on every event — observed killing an in-flight workflow run on a day when no `dist/` file had been written at all. `dev/distSignature.mjs` (`newestDistMtimeMs` + the pure `shouldRestartForDist`) is the guard: `restartPolicy` re-baselines dist/'s newest mtime (files **and** directories, so a create/delete counts) before arming the watcher and after every applied restart, and ignores an event whose tree is no newer. It **fails open** — an unreadable dist/ (`null`) restarts anyway, since missing a real rebuild is worse than one spurious restart. A metadata-only event also must not arm a *deferral*, or the poll would apply it once the run.lock cleared. The restart/ignore logs now name the `eventType`+`filename` that fired (`describeDistEvent`), so an unexplained restart is attributable. Unit-tested in `src/__tests__/distRestartVerify.test.ts`.
- **This runner is the only witness to `dist/index.js` dying.** The root orchestrator sees this process, not the backend it spawns, so a death that the backend cannot log from the inside (a hard native fault, an OS OOM-kill, an external `taskkill` — none of which run any JS, so `backend/src/crashLog.ts` writes nothing) is recorded ONLY here. `dev/backendLifecycle.mjs` therefore calls `recordExit` into `~/.lattice/logs/dev-runner.log` on every abnormal exit and decodes the code through `dev/exitStatus.mjs`, so `3221225477` prints as `0xC0000005 STATUS_ACCESS_VIOLATION` instead of looking like an ordinary non-zero exit. That gap is exactly how the 2026-08-20 crash escaped every log Lattice keeps. Unit-tested in `src/__tests__/devExitStatus.test.ts`.
- Preserve the dev-runner contract: exact log messages, copy assets before every backend spawn, defer restarts while live per-project `run.lock` files exist, and call terminal-server `/shutdown` only during real shutdown.
- Shutdown takes precedence over a pending backend respawn. Failed child spawns are observed; failed kills keep the old child tracked. Terminal `/shutdown` must carry `x-lattice-terminal-token` read from the existing `~/.lattice/terminalServerToken`; never create/rotate that token during shutdown. Runtime watcher `error` events must be handled as well as construction failures.
- `4294967295` is unsigned exit `-1`, not proof of a native fault. The TypeScript watcher now records its own `tsc-watch` exit in `dev-runner.log`, and the outer orchestrator also decodes exit statuses. Retain unexpected nonzero/signal exits' live console mirrors; remove mirrors for requested restarts/shutdowns.
- **A TypeScript watcher failure is isolated from the running app.**
  `dev/compilerLifecycle.mjs` retries only the compiler after 1/2/5/10/30 seconds;
  after those retries it visibly pauses automatic compilation and retains the
  backend/frontend/terminals. It never calls terminal shutdown or exits this
  runner. A successful watch-status line does not replenish the budget: only
  five minutes after successful compilation counts as stable uptime. Shutdown
  cancels pending repairs and fences callbacks; operation errors from a live
  compiler do not admit another compiler writing the same `dist/`.
- `dev/tscWatch.mjs` forces English, non-pretty status output and anchors whole
  compiler-status lines (with optional localized clock prefixes). Every compile
  start/errors/death fences backend restarts, including an already-deferred
  restart poll; only a zero-error completion permits restart. It retains bounded
  compiler stdout/stderr lines, Node version/platform/PID and decoded exit status
  in the dev-runner log. The diagnostic waits for `close` to drain final output,
  with a one-second fallback; compiler repair itself starts on `exit` immediately.
- On compiler retry, source files use TypeScript's `dynamicPriorityPolling`.
  This may cost more CPU than native notifications. Windows recursive directory
  watches remain native: installed TypeScript ignores `watchDirectory` selection
  on hosts with recursive `fs.watch`, so do not claim this identifies/eliminates
  the unexplained exit cause or switches every watcher to polling.
- Successful compiles explicitly notify the restart policy, so edits made during
  compiler downtime cannot disappear behind a reset mtime baseline. A completed
  output content signature suppresses identical cold/recovery re-emissions.
  Content hashing runs per completed compile/spawn, not per metadata event or
  idle poll. Real changes still obey all existing project run locks. The output
  version is captured after asset copying and before backend spawn, then committed
  only on the child's actual `spawn` event: an accepted kill that later fails
  cannot claim new code is running, and a subsequent compilation cannot stamp
  partial output as the spawned backend's version. Stopping the restart policy
  clears both its deferred poll and its dist debounce.
- The `MAX_DEFER_MS` force-restart backstop (`dev/restartPolicy.mjs`) applies **only** to a short, re-runnable/auto-resumed op (a `merge-run` / `manual-merge` lock). A live **workflow** control-step lock (`workflow-*`, `workflowRunInFlight`) is exempt and defers the restart **indefinitely** — a workflow's Merge step legitimately holds the lock for the whole time its tasks commit (routinely > 15 min), and the workflow run is in-memory only, so force-killing it strands its completed-but-unmerged tasks and cascades the queue onto the next workflow. The label/timing decision is the pure `classifyDeferAction` (unit-tested in `src/__tests__/restartPolicyDefer.test.ts`). NOTE: the lock only covers control steps — a restart during a workflow's **agent** steps holds no lock and is not deferred. That is now *survivable* rather than fatal: runs are mirrored to disk (`src/workflowRuns/persistence.ts`) and re-adopted on the next boot (`src/recovery/workflowRunResume.ts`), so a restart mid-agent-step resumes instead of silently stranding the run. The defer still matters for control steps, where the in-process worker cannot be re-adopted, only re-run.
