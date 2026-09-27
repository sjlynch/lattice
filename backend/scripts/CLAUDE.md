# Backend scripts

- `dev.mjs` is the backend dev-runner entrypoint. Keep it readable as: self-heal deps → initial compile/assets → start the compiled backend → supervise `tsc -w` and watch `dist/` → real shutdown.
- Focused helpers live under `backend/scripts/dev/`: dependency/npm helpers, compile/assets orchestration, run.lock scanning (`runLocks.mjs`) and restart deferral (`restartPolicy.mjs`), the backend restart handshake (`restartHandshake.mjs`), dist watching, and backend/terminal lifecycle.
- `dev/parkedProbe.mjs` — per-policy lock-holder report cache with an injected clock, query and TTL; owns single-flight queries, exact lock-set keys, and half-TTL refreshes during parked holds.
- `dev/compileAssets.mjs` — the initial `tsc` compile (`resolveTscBin`, `runInitialCompile`) and asset copying via `copy-assets.mjs` (`runInitialCopyAssets`, `copyAssetsBeforeRespawn`); re-exports `startTscWatch` from `dev/tscWatch.mjs`.
- `dev/distWatcher.mjs` — `watchDist(onChange)`: recursive `fs.watch('dist')` (Windows/macOS) with a chokidar fallback on Linux; forwards `eventType`/`filename` so a restart is attributable.
- `dev/liveLog.mjs` — `clearLiveLog(pid)`: deletes the backend's `~/.lattice/logs/live-backend-<pid>.log` mirror after a deliberate kill (Windows `TerminateProcess` runs no JS in the child), so a routine restart isn't promoted to a `-nojs` crash log on the next boot. Called from `dev/backendLifecycle.mjs`.
- `dev/deps.mjs` `selfHealDeps` is the second self-heal layer behind the root `scripts/preflight.mjs` (for when this runner is started on its own). Both use the shared `scripts/depsCheck.mjs`: every dep `backend/package.json` declares must be installed at the version `package-lock.json` pins. Keep it manifest-driven — a hand-picked `REQUIRED_PKGS` sample is how a pulled `@modelcontextprotocol/sdk` + `zod` addition sailed past the check and failed the initial `tsc` instead (2026-09-06).
- **`fs.watch('dist')` is not a "code changed" signal on Windows.** libuv arms `ReadDirectoryChangesW` with a filter that also covers ATTRIBUTES / LAST_ACCESS / CREATION / SECURITY, so an NTFS last-access flush (`fsutil behavior query disablelastaccess` = 0 on the affected machine → last-access updates enabled), an antivirus/indexer scan, or an ACL refresh fires it with nothing written. The runner used to restart on every event — observed killing an in-flight workflow run on a day when no `dist/` file had been written at all. `dev/distSignature.mjs` (`newestDistMtimeMs` + the pure `shouldRestartForDist`) is the guard: `restartPolicy` re-baselines dist/'s newest mtime (files **and** directories, so a create/delete counts) before arming the watcher and after every applied restart, and ignores an event whose tree is no newer. It **fails open** — an unreadable dist/ (`null`) restarts anyway, since missing a real rebuild is worse than one spurious restart. A metadata-only event also must not arm a *deferral*, or the poll would apply it once the run.lock cleared. The restart/ignore logs now name the `eventType`+`filename` that fired (`describeDistEvent`), so an unexplained restart is attributable. Unit-tested in `src/__tests__/distRestartVerify.test.ts`.
- **This runner is the only witness to `dist/index.js` dying.** The root orchestrator sees this process, not the backend it spawns, so a death that the backend cannot log from the inside (a hard native fault, an OS OOM-kill, an external `taskkill` — none of which run any JS, so `backend/src/crashLog.ts` writes nothing) is recorded ONLY here. `dev/backendLifecycle.mjs` therefore calls `recordExit` into `~/.lattice/logs/dev-runner.log` on every abnormal exit and decodes the code through `dev/exitStatus.mjs`, so `3221225477` prints as `0xC0000005 STATUS_ACCESS_VIOLATION` instead of looking like an ordinary non-zero exit. That gap is exactly how the 2026-08-20 crash escaped every log Lattice keeps. Unit-tested in `src/__tests__/devExitStatus.test.ts`.
- Preserve the dev-runner contract: exact log messages, copy assets before every backend spawn, defer restarts while live per-project `run.lock` files exist, drain the backend before every restart (failing open), and call terminal-server `/shutdown` only during real shutdown.
- **Soft stop (dev console `r` / `d`).** Under the root orchestrator this
  runner's stdin is a control pipe (`LATTICE_DEV_CONTROL=stdin`, deleted from
  `process.env` on read so `dist/index.js` and its agent ptys never inherit it;
  protocol in `scripts/orchestrate/devControl.mjs`). `soft-stop` runs the normal
  shutdown with `keepTerminals` — watchers, deps watch, compiler and backend
  stop, the terminal-server `/shutdown` is skipped — so the next runner's backend
  re-adopts every live pty. A real stop landing during a soft one (Ctrl+C right
  after `r`) still sends the `/shutdown` (once). `onExit` must never call
  `shutdown()` with its full-stop default, or a soft stop would become a full
  one. Before the backend exists a soft stop just exits. With no backend child
  (crashed; its backoff respawn is cancelled by the stop) shutdown exits the runner itself — the
  control pipe would otherwise keep it alive.
- **Dependency changes after boot.** The shared `scripts/depsWatch.mjs` watches
  `backend/package.json` + `package-lock.json`; on a mismatch it runs
  `npm install` in `backend/` (output as `[npm:backend]`, failures recorded in
  `dev-runner.log` and not retried until the files change — `deps-recheck`,
  the console's `i`, forces one). After a successful install
  `compilerLifecycle.restart()` replaces `tsc -w` (a watcher that failed
  "Cannot find module" may never re-resolve on its own; the deliberate restart
  is recorded as expected and spends no retry budget, and it also revives a
  compiler paused after exhausting its retries), and the next successful
  compile forces a backend restart through `restartPolicy.onDistChanged(true)`
  even when dist/ is byte-identical (a bumped runtime dep changes nothing in
  dist/) — still deferred while a run.lock is held. Covered by
  `src/__tests__/depsWatch.test.ts` and `src/__tests__/devCompilerRestart.test.ts`.
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
- **Restart deferral** (`dev/restartPolicy.mjs`; decision = pure `classifyDeferAction`, unit-tested in `src/__tests__/restartPolicyDefer.test.ts` + `devRestartHandshake.test.ts`). A dist/ change while a live run.lock is held is deferred; a 3 s poll applies it once the lock clears. The poll returns before any scan while nothing is deferred.
  - **`MAX_DEFER_MS` (15 min) force backstop** applies only to a re-runnable, auto-resumed op (`merge-run` / `manual-merge` lock) and is for a **wedged** holder.
  - **Parked on a live agent ≠ wedged.** A merge run parked on a conflict-resolver / post-merge-hook agent holds the lock as long as that agent works. Before forcing, the poll asks the backend (`GET /api/internal/restart-drain/lock-holders`, `backend/src/restartDrain/`) and keeps deferring (`'hold-parked'`: re-logged every 5 min, re-asked every 30 s) while EVERY held lock belongs to that backend's pid and is parked on a live agent. Not parked, or no answer → forced as before; the log says why.
  - **Workflow locks are exempt** (`workflow-*` incl. Run tests' `workflow-test:*`; `workflowRunInFlight`) and defer **indefinitely**: a Merge step holds the lock while its tasks commit (routinely > 15 min). The run record survives a restart (`workflow-runs.json`, `src/recovery/workflowRunResume.ts`), but the in-process control step can only re-run from the top — churn, not lost work.
  - **Agent steps hold no lock**, so a restart during one isn't deferred. Survivable: runs are mirrored to disk (`src/workflowRuns/persistence.ts`) and re-adopted at boot; the agent pty survives in the detached terminal-server.
  - Defer / hold / force lines name the holder (`<hash> label=… pid=… startedAt=…`).
- **`dev/runLocks.mjs`** — the run.lock scan the policy (and `scripts/orchestrate.mjs`, via `restartPolicy.mjs`'s re-exports) uses: `heldRunLocks`, `describeRunLocks`, `workflowRunInFlight`, `locksParkedOnLiveAgents`. `node:` builtins only.
  - A lock counts only if its holder is provably local and alive: same `hostname`, live PID, **and** an OS start time no newer than the lock's `startedAt` (PID-reuse check ported sync from `backend/src/projectRunLock/liveness.ts` — PowerShell on win32, `ps -o lstart=` on POSIX). A recycled-PID stale lock once held restarts 15 min unexplained (2026-09-22).
  - That probe is cached once per `(pid, startedAt, ownerId)` lock body in the module-level `START_TIME_CACHE` singleton, so the 3 s poll never re-spawns PowerShell.
- **Every restart is preceded by a drain handshake** (`dev/restartHandshake.mjs`; backend half `backend/src/restartDrain/`). Deferred restarts first wait `LOCK_SETTLE_MS` (5 s) after the last run.lock was seen (`'settle'`) — a control step releases its lock *before* its advance dispatches the next step, and the frontend queue starts the next workflow the moment one ends; applying on the first lock-free poll landed in exactly those hand-offs. Then `POST /api/internal/restart-drain/prepare` puts the backend in a TTL-bounded drain (no new spawns / run-lock acquisitions; new workflow/merge/task starts 503 + Retry-After), waits for in-flight transitions (≤ 45 s), flushes debounced state, and answers; only then is the backend killed. A run.lock taken while it drained → `/cancel` + re-defer; a compile that started meanwhile, or a restart the lifecycle refuses → `/cancel`; a handshake that straddles a backend spawn is dropped (`spawnGeneration`). It **fails open**: no token file, backend unreachable/404/timeout, or `ready:false` → restart anyway with a log line naming why. Auth = the existing `~/.lattice/terminalServerToken` in `x-lattice-terminal-token` (read-only here, like `/shutdown`); the route refuses any browser `Origin`. No backend running (`needsBackendStart`) → no handshake. The dev console's **soft stop** (`r` / `d`, `soft-stop` on the control pipe) drains through the same `prepare` before its kill (`dev/devShutdown.mjs`), on a shorter budget (`SOFT_STOP_SETTLE_BUDGET_MS` 10 s / `SOFT_STOP_PREPARE_TIMEOUT_MS` 15 s) that fits inside the orchestrator's `SOFT_STOP_TIMEOUT_MS`; it does not re-check run.lock (the orchestrator already refused the soft stop unless forced with `r!` / `d!`), and a Ctrl+C mid-drain kills at once. A real stop (Ctrl+C / SIGTERM) never drains.
- **A backend that exits on its own is respawned on a backoff** (`dev/backendLifecycle.mjs` `CRASH_RESPAWN_DELAYS_MS`: 2 s, 5 s, 10 s, 30 s, then every 60 s; reset once a backend stayed up `CRASH_STABLE_UPTIME_MS` = 5 min). It used to wait for the next dist/ change, so one transient crash — or a boot that lost the port race with a backend still shutting down — left Lattice down until a file was saved. The exit is still recorded (`recordExit`, port-held hint) first; a dist/ change still retries at once (and cancels the timer); shutdown wins (the timer re-checks `isShuttingDown`, `kill()` cancels it); a compiler fence at fire time skips the spawn (the next successful compile starts it). The first delay is deliberately non-zero: on Windows Ctrl+C reaches `dist/index.js` too, and its exit can be observed a moment before this runner's own signal handler flags the shutdown. Timers are `unref`'d. Covered in `src/__tests__/devBackendLifecycle.test.ts`.
