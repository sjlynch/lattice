# backend/src

Express server (`:5184`) plus a detached PTY executor (`terminal-server.ts`, `:5185`).
The root is flat: most `x.ts` files are stable re-export shims over an `x/`
folder. Where a folder has a `CLAUDE.md`, read that instead of expecting detail here.

## Layout

### Bootstrap & server

- `index.ts` — entry: `server/bootGuards.ts` first (before touching `~/.lattice`), then `processGuards`, the `inheritedAgentEnv` scrub, then dynamic import of `server/startup.ts`.
- `inheritedAgentEnv.ts` — drops an outer Claude Code session's identity env at boot so sidebar Claudes don't think they're its children; user config vars are kept.
- `server/` — config, Express app + route mounting, HTTP/WS wiring, startup ordering. See `server/CLAUDE.md`.
- `routes/` — one `buildXRouter()` per domain, mounted from `server/app.ts`. See `routes/CLAUDE.md` for the route map.
- `ws/` — the single `upgrade` dispatcher (`wsServer.ts`) + endpoint builders under `ws/endpoints/`. See `ws/CLAUDE.md`.
- `wsOriginAllowlist.ts` — CSWSH defence: the one browser-`Origin` allowlist shared by `ws/wsServer.ts` and the executor's `terminalServer/websocket.ts`.
- `restartDrain/` — backend half of the dev-runner restart handshake (drain, settle, flush, lock-holder report). See `restartDrain/CLAUDE.md`.
- `recovery.ts` / `recovery/` — boot recovery: tasks.json restore, snapshots, orphan worktrees, queued runs, workflow / one-off / merge-run resume. See `recovery/CLAUDE.md`.
- `globalSettings.ts` / `globalSettings/` — `~/.lattice/globalSettings.json` read/write facade; field validators live beside their shapes. See `globalSettings/CLAUDE.md`.
- `userSettings.ts` / `userSettings/` — per-project `<project>/.lattice/userSettings.json` barrel. See `userSettings/CLAUDE.md`.
- `serializeWrites.ts` — `runExclusive(key, fn)`: per-key promise chain so overlapping settings read-modify-writes can't clobber each other.

### Project identity & state

- `projectPath.ts` — single source of truth for per-project paths under `~/.lattice/` (`canonicalProjectPath`, `projectHash`, `homeProjectDir`, …) + the `isRealAbsoluteProjectPath` route guard.
- `projectIdentity.ts` — realpath identity + durable legacy-hash bindings behind `projectPath.ts`, so path aliases share one store. Submodules in `projectIdentity/` (see `projectIdentity/CLAUDE.md`); rationale in `PROJECT_IDENTITY.md`.
- `projectStateManager.ts` / `projectState/` — generic per-project cached, debounced-persisted state store (tasks, workflows, merge runs, terminal registry). See `projectState/CLAUDE.md`.
- `projectInit/` — "Set up Git": `git init` a non-repo folder into a usable project. See `projectInit/CLAUDE.md` (two invariants).
- `ids.ts` — task / workflow / terminal-session id generators.

### Tasks, merge & runs

- `tasks.ts` / `taskCache.ts` / `taskCache/` — shims over the in-memory task cache + debounced `per-project/<hash>/tasks.json` persistence. See `taskCache/CLAUDE.md`.
- `taskSpawnEvents.ts` — `task-spawned` / `task-spawn-failed` pub/sub: a queued run's pty (or its non-CAP failure) reaches the UI over `/ws/tasks`.
- `taskVerification.ts` — renders `taskAgentTypecheck`: task agents run no tests/builds/type-checks, stated in the brief AND the system prompt.
- `worktree.ts` / `worktree/` — git-worktree subsystem: setup, merge, `projectGit`, `gitBackup`, disk guard, snapshots. See `worktree/CLAUDE.md`.
- `mergeRuns.ts` / `mergeRuns/` — "merge all" engine: public singleton + worker loop here, state/preflight/per-target helpers in the folder. See `mergeRuns/CLAUDE.md`.
- `mergeLocks.ts` — in-process per-task merge lock so a manual `/merge` can't race the run worker.
- `projectRunLock.ts` / `projectRunLock/` — cross-process per-project `run.lock` (labels, lendability, `inspectProjectRunLock`). See `projectRunLock/CLAUDE.md`.
- `diskPressureMerge.ts` — starts a merge run when task runs wait on disk, plus the once-a-minute low-disk monitor (opt-out `autoMergeOnLowDisk: false`).
- `workflows.ts` / `workflows/` — workflow definitions (`<project>/.lattice/workflows.json`) + `{{var}}` interpolation. See `workflows/CLAUDE.md`.
- `workflowRuns.ts` / `workflowRuns/` — workflow-run engine facade: step groups advance in order; adjacent `parallel: true` agent (planning) steps run together as one group (`execution.ts` `nextStepGroup`). See `workflowRuns/CLAUDE.md`.
- `workflowPromptCustomizations.ts` / `workflowPromptCustomizations/` — spawn a harness to tailor a workflow step prompt. See its `CLAUDE.md`.
- `homeScratch/` — shared home-scoped scratch contract (path guard, session setup, bounded cleanup, persistence) for push / QA / post-merge runs. **Path-guard / cleanup changes go here.** See its `CLAUDE.md`.
- `pushRuns.ts` / `pushRuns/` — one-off push sessions: QA-lane Push (brief `push`) and workflow Push (brief `workflow-push`). See `pushRuns/CLAUDE.md`.
- `qaRuns.ts` / `qaRuns/` — QA-lane Playwright e2e sessions; a confident PASS promotes qa → done. See `qaRuns/CLAUDE.md`.
- `postMergeHooks.ts` / `postMergeHooks/` — optional per-project post-merge harness that gates merge completion on its callback. See `postMergeHooks/CLAUDE.md`.
- `deadCode.ts` — distils the health analyzer's reachability into confidently-dead files for `GET /api/health/dead-code` and the `LATTICE_TASK.md` note.

### Agents & harness commands

- `harnesses.ts` — the `AgentHarness` vocabulary (`claude`/`pi`/`codex`) + `agentHarnessForCommand`; reuse it instead of open-coding harness unions.
- `harnessDetect.ts` — PATH probe for installed agent CLIs; memoizes only definitive results (a timed-out / failed probe is "unknown": reported unavailable, never cached, re-probed in the background and pushed via `onHarnessAvailabilityChange`). `resetHarnessCache()` re-probes; drives `/ws/harnesses`.
- `agentCommandBuilder.ts` — shared harness command syntax: permission-bypass flags, Pi `--approve` + validated `--model`, shell quoting.
- `spawnQueue.ts` / `spawnQueue/` — admission controller in front of every agent spawn (`softCap` = `maxConcurrentAgents`; defers, never drops). See `spawnQueue/CLAUDE.md`.
- `queuedCreateSession.ts` — spawn-queue-gated `proxyCreateSession` for sites that await their pty (resolvers, post-merge, push, QA, prompt customization).
- `concurrencyLimit.ts` — tiny FIFO bounded-concurrency gate (e.g. the health watcher's file reads).
- `instructionTemplates.ts` / `instructionTemplates/` — editable agent-brief templates with `{{token}}`s + per-project overrides. See its `CLAUDE.md`.
- `harnessSystemPrompts.ts` / `harnessSystemPrompts/` — per-harness system-prompt Append/Replace + the always-on Lattice preamble, injected at the spawn chokepoint. See its `CLAUDE.md`.
- `latticeApiDocs.ts` / `latticeApiDocs/` — generates `<project>/.lattice/LATTICE_API.md` (short index the preamble names, size-budgeted by test) + `LATTICE_API_RECIPES.md` from `*.template.md`. `latticeApiDocs/docPath.ts` only names the doc path, so the terminal-server's fingerprinted import graph skips the generator/templates — **never import `latticeApiDocs.ts` from terminal-server code** (every API tweak would mark the executor stale).
- `claudeStopHook.ts` — renders `.claude/settings.local.json` Stop + activity hooks for worktrees and non-worktree sessions (via the callback script).
- `codexStopHook.ts` — `.codex/hooks.json` Stop + activity hooks (if-absent write; only `ENOENT` is absent — any other read error leaves the file untouched); Codex's `Stop` fires once, so no quiescence gate.
- `piExtension.ts` / `piExtension/` — Pi's `lattice-complete.ts` completion backstop (`session_shutdown` → callback). See `piExtension/CLAUDE.md`.
- `callbackOutbox.ts` / `callbackOutbox/` — durable completion callbacks: `lattice-callback.cjs`, the outbox, replay after a restart. See its `CLAUDE.md`.
- `claudeTrust.ts` / `claudeTrust/` — writes `~/.claude.json` folder trust + managed MCP entries (apply side only). See `claudeTrust/CLAUDE.md`.
- `claudeConfigGuard.ts` — backup/restore policy for a `~/.claude.json` truncated by a force-killed Claude (boot, periodic, post-kill).
- `agentQuiescence.ts` — per-session live-subagent / last-signal tracker behind the workflow-step and post-merge-hook Stop-hook gates (`*/stopHookGate.ts`).

### Activity hooks (graph beams + subagent satellites)

- `claudeHookBody.ts` — shared parsing of Claude-shaped hook POST bodies.
- `hookFiles.ts` — which file(s) a hook body names, per harness (Claude `file_path`; Codex `apply_patch` headers + existence-checked shell reads).
- `codexCodeActivity.ts` — reads literal shell/patch arguments from hosted Codex `exec` scripts without executing JavaScript; used by the worktree activity fallback in `terminalRegistry/codexTaskActivity.ts`.
- `activityHook.ts` — route-neutral decode into file activity or `SubagentStart`/`SubagentStop` lifecycle, shared by all three activity routes.
- `taskActivityEvents.ts` — `task-activity` pub/sub for worktree agents (`routes/tasks/activity.ts` → `/ws/tasks`).
- `agentSessions.ts` — presence registry for non-worktree / project-instrumented sessions (register at spawn, unregister at callback) → `/ws/agent-sessions`.
- `agentActivity.ts` — `agent-activity` pub/sub (file beams) for those sessions, fed by `routes/agentActivity.ts`.
- `agentActivityTokens.ts` — HMAC token minted into `/api/agent-activity/:token` hook URLs; secret persisted under `~/.lattice`.
- `piActivity.ts` — generates Pi's `.pi/extensions/lattice-activity.ts`, posting Claude-shaped bodies from `tool_execution_start/end`.
- `projectClaudeHooks.ts` — merge-installs activity hooks into the project's own `.claude/settings.local.json` (temp + rename; never overwrites an unparseable or unreadable file — only `ENOENT` is absent).
- `projectCodexHooks.ts` — Codex analogue for user-opened Codex tabs: per-launch `--config hooks.*` overrides + `--dangerously-bypass-hook-trust` (`CODEX_HOOK_TRUST_BYPASS_FLAG`); nothing written to the repo or `~/.codex` (`wantsProjectCodexHooks`, `projectCodexHookConfigArgs`, `withCodexHookTrustBypass`).
- `projectClaude/` — project-root Claude instrumentation behind `routes/projectClaude.ts`: hook reconcile, session presence lifecycle, activity fan-out. See `projectClaude/CLAUDE.md`.

### Terminal (detached PTY executor)

- `terminal-server.ts` / `terminalServer/` — the detached executor's entry + routes, WS, guards, shutdown. See `terminalServer/CLAUDE.md`.
- `terminal.ts` / `terminal/` — the executor's pty-session core (create, attach, kill, scrollback, output facts). See `terminal/CLAUDE.md`.
- `terminalConfig.ts` — executor tunables (scrollback replay / flush / on-disk log sizes).
- `terminalProtocol.ts` — wire protocol version, capability flags, session-request age limits shared by both processes.
- `terminalServerAuth.ts` — persisted bearer token guarding the executor's mutating HTTP routes (`x-lattice-terminal-token`).
- `persistedSecretFile.ts` — load-or-create for `~/.lattice` secrets (terminal token, `agentTokenSecret`): regenerates only on ENOENT (exclusive `wx` create, re-read on EEXIST) or an unusable value; any other read error retries, then throws — **never overwrite a secret you couldn't read** (running executors / baked hook tokens still hold it).
- `terminalFingerprint.ts` — hash of the executor's source bytes; every file the executor imports must be in `FINGERPRINT_FILES`.
- `terminalServerLifecycle.ts` — spawn / respawn / health probe of the executor (`BASE`, `ensureTerminalServer`).
- `terminalServerStatus.ts` — read-only `current|stale|absent|unavailable` for the navbar "update pending" chip; never triggers the upgrade itself.
- `terminalServerClient.ts` / `terminalServerClient/` — backend HTTP client for the executor (probes, kills, the `POST /sessions` spawn chokepoint). See its `CLAUDE.md`.
- `terminalProxy.ts` — public façade over lifecycle + client + `terminalWsRelay.ts`; its kill wrappers end terminal-registry records.
- `terminalWsRelay.ts` — relays browser `/ws/terminal` to the executor (connect timeout, input notes, Codex title default).
- `terminalBanner.ts` — the dim scrollback banner naming `LATTICE_API.md`; tells the user, never reaches the agent.
- `terminalRegistry/` — durable terminal-tab registry + restore-on-open. See `terminalRegistry/CLAUDE.md`.
- `terminalActivity.ts` — per-tab "agent still working" signal (`/ws/terminal-activity`): Codex status title, Claude/Pi sustained printable output.
- `terminalActivityPoller.ts` — the shared **display-only** poll (generation fencing, 5 s staleness expiry); never affects pty/task/workflow liveness.
- `terminalActivityRelay.ts` — title facts parsed from browser streams, only for old executors lacking `capabilities.nativeTerminalTitle`.
- `codexTerminalActivity.ts` — per-launch Codex `-c` defaults: status-only terminal title + `tui.terminal_resize_reflow_max_rows` (500).
- `processTree.ts` — the one home for process-tree kills (don't add another): `killProcessTreeWindows` (`taskkill /F /T` after `pty.kill`, `terminal/kill.ts`) + shell-aware `killChildTree(child, {shell})` (`spawnWithTimeout.ts`).
- `nodePtyCleanupFailure.ts` — recognizes the one ignorable Windows node-pty cleanup `TypeError` (by stack frame, not message alone).

### Git watchers, search & graph

- `gitBranch.ts` — navbar branch label + read-only `.git/HEAD` watcher (`/ws/git-branch`); `rearmGitBranchWatcher` is called by `projectInit` after `git init`.
- `gitStatus.ts` — read-only git-dir + working-tree watchers → status signature (`/ws/git-status`); `computeStatusSignature` never rejects; `rearmGitStatusWatcher` likewise.
- `gitWatcherRegistry.ts` — the per-project watcher registry behind both: one lazy watcher per canonical root shared by all subscribers, per-subscriber-isolated fan-out, the `rearm` path. **Slots live for the process lifetime** (no close on last unsubscribe — avoids churn on WS reconnect storms): each distinct canonical root opened keeps its HEAD watcher + `gitStatus.ts`'s two recursive `watchTree` handles, bounded by the number of distinct roots. Keep that design unless replacing it, and always key by `canonicalProjectPath` — every new path spelling would add a duplicate set of recursive watchers.
- `gitDir.ts` — `resolveGitDir`: walks up like git and follows a worktree's / submodule's `.git` pointer file (`gitdir: <path>`), so watchers watch the real git dir.
- `gitHistory.ts` / `gitHistory/` — the timeline scrubber's `git log`, ghost-node `deletedPaths`, status signature. See `gitHistory/CLAUDE.md`.
- `watchTree.ts` — win32 recursive `fs.watch` (one handle) replacing chokidar's per-dir handles, which locked directories; `LATTICE_WATCH_MODE` overrides; symlinks not followed.
- `search.ts` — file-contents search for `/api/search`; `regexSource` wildcards must match the frontend's `forceGraph/searchMatcher.ts`; returns absolute paths (= graph node ids). Its JS fallback (`search/jsGrepWorker.ts`) greps in a worker thread with a wall-clock budget, so a ReDoS user regex can't freeze the event loop.
- `ripgrep.ts` — optional memoized `rg` fast path for `search.ts` (`LATTICE_DISABLE_RG`, `LATTICE_RG_PATH`); cancel-poll interval shared with the JS fallback in `search/constants.ts`.
- `scanner.ts` / `scanner/` — project → `{nodes, links}` graph pipeline; `scanner.ts` is a re-export facade. See `scanner/CLAUDE.md`.
- `health/` — tree-sitter per-file metrics, health score, cross-file dead code, file watcher. See `health/CLAUDE.md`.
- `fsbrowse.ts` / `fsbrowse/` — folder-picker backend (roots, validation, listing, create-dir).

### Pi / MCP / tools

- `piModels.ts` / `piModels/` — Pi model discovery, menu, models.json reconcile, endpoint probe / auto-discovery, thinking levels. See `piModels/CLAUDE.md`.
- `piProviderValidation.ts` — `PiProvider` types + validation of `globalSettings.piProviders` (re-exported from `globalSettings.ts`).
- `spawnWithTimeout.ts` — spawn + capture output + kill-on-timeout (whole child tree via `processTree.ts` `killChildTree`) for bounded external CLI calls: Pi model listing/installs, Opengrep.
- `piSubagents.ts` / `piSubagents/` — auto-installs `@tintinweb/pi-subagents` + cwd-exact shims (incl. the project root). See `piSubagents/CLAUDE.md`.
- `piMcp.ts` / `piMcp/` — Pi MCP via `pi-mcp-adapter`; the backend writes cwd `.pi/mcp.json` + shim at spawn (`applyPiMcpForSpawn`). See `piMcp/CLAUDE.md`.
- `mcp/` — MCP control plane: catalog, per-harness resolvers, secrets, import; resolved in the backend, applied by the executor. See `mcp/CLAUDE.md`.
- `latticeMcp/` — Lattice's own first-party stdio MCP server over the task-board API. See `latticeMcp/CLAUDE.md`.
- `opengrep/` — Opengrep SAST as a user-installed pre-run tool; nothing third-party is committed or bundled. See `opengrep/CLAUDE.md`.

### Crash & logging

- `processGuards.ts` — swallows only the node-pty cleanup throw; anything else logs, writes a crash file and exits 1 (hard-exits if the console is stalled).
- `crashLog.ts` — console ring, sync `~/.lattice/logs/crash-*.log`, Node diagnostic report, `live-*.log` mirror promoted to `*-nojs.log` next boot. Best-effort, never fatal. `crashLog/`: `format.ts` (pure), `liveMirror.ts` (live mirror + `-nojs` promotion), `retention.ts` (newest N per kind; `-nojs` has its own bucket).
- `consoleSink.ts` — async, bounded (256 KB) console writes, so a stalled console (a Windows text selection) drops lines instead of freezing the process.

### Misc

- `__tests__/` — node:test suite. See `__tests__/CLAUDE.md`.
- `AGENTS.md` — pointer to this file for non-Claude harnesses.

## Key invariants

- **One active merge run per project** — in-process (`mergeRuns.ts`, second start → 409) *and* cross-process (`projectRunLock.ts`).
- **Workflow runs survive a backend restart** — mirrored to `per-project/<hash>/workflow-runs.json`, re-adopted on boot (`recovery/workflowRunResume.ts`). Agent-step ptys survive in the executor, so the pending `/complete` still advances the run; control steps are re-dispatched. Keep `restoreWorkflowRun` idempotent and the mirror current on every run mutation.
- **Push runs, QA runs and post-merge hooks survive a restart too** — mirrored to `per-project/<hash>/{push-runs,qa-runs,post-merge-hooks}.json` (`homeScratch/persistence.ts`); `recovery/oneOffRunResume.ts` re-adopts live-pty records **before listen** (callbacks land; a resumed merge run awaits the live hook; a re-dispatched workflow Push re-attaches instead of pushing twice). A dead one is settled as lost after a callback-outbox grace. Re-adopted Claude sessions get the longer `READOPTED_SETTLE_MS` quiescence window.
- **Merge runs survive a backend restart** — `scripts/dev.mjs` defers restarts while a `run.lock` is held, and boot's `resumeInterruptedMergeRuns` restarts any run whose lock is stale. So `startMergeRun` must tolerate a half-processed task set.
- **Per-task merge lock** (`mergeLocks.ts`) — manual `/merge` can't race the run worker.
- **Crash-safe ordering** — `updateTaskCrashSafe` writes disk before cache; used for `ready_to_merge → qa`.
- **Merge in the worktree, not main** — see `worktree/merge.ts`. Main's tree only ever changes by fast-forward.
- **All project-repo git goes through `projectGit`** — never raw `exec('git', …, repoRoot)`. Worktree-side git stays on `exec` (disposable, and it needs the real `git merge` `projectGit` forbids).
- **No `fs.rm({recursive})` on anything inside a project** — worktrees live outside the tree and teardown delegates to `git worktree remove`. One-off scratch cleanup is an intentional recursive delete, bounded to `per-project/<hash>/{push,qa,post-merge-hooks}/<id>/` with path + reparse-point guards.

## Type-check

`src/` is the source of truth; `dist/` is generated by `tsc` — don't edit it.
`npx tsc --noEmit` from `backend/`. Tests: `npm test` (node:test via `tsx`,
runs `src/__tests__/*.test.ts`).

`tsc` only emits `.js` for `.ts`. Non-TS runtime assets under `src/` (currently
`workflowRuns/create-task-template.cjs` and both
`latticeApiDocs/LATTICE_API.template.md` +
`latticeApiDocs/LATTICE_API_RECIPES.template.md`)
are copied into `dist/` by `scripts/copy-assets.mjs`, run from **both**
`npm run build` and `npm run dev` (`scripts/dev.mjs`, right after the initial
`tsc`). New asset → add it to `copy-assets.mjs`'s list (one place, both paths).
Missing the helper asset crashes backend boot with `ENOENT … dist/…` because
`renderHelperScript.ts` reads it synchronously at module initialization.
`latticeApiDocs.ts` loads templates lazily, trying the dist-adjacent path then
the source-tree fallback; if neither yields a valid template, it warns once
about disabled generation, caches `null`, and disables that file's generation
for the process lifetime. Missing API-doc templates degrade docs without
failing import; `refreshLatticeApiDocs` also catches generation failures so
a spawn remains possible.
