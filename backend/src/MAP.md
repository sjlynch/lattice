# backend/src module map

On demand (not auto-loaded): which module owns what. Rules for the whole
backend are in `CLAUDE.md` beside this file; a folder's own rules are in its
`CLAUDE.md`. Convention: a domain's public surface is the root `x.ts` facade
beside its `x/` folder ("`x.ts` / `x/`" below); "See its doc" = that folder's
`CLAUDE.md`. Keep this map in step when you add, move or delete a module.

## Bootstrap & server

- `index.ts` — entry: `server/bootGuards.ts` first (before touching `~/.lattice`), then `processGuards`, the `inheritedAgentEnv` scrub, then `server/startup.ts`.
- `inheritedAgentEnv.ts` — drops an outer Claude Code session's identity env at boot so sidebar Claudes don't think they're its children; user config vars are kept.
- `server/` — config, Express app + route mounting, HTTP/WS wiring, startup ordering. See its doc.
- `routes/` — one `buildXRouter()` per domain, mounted from `server/app.ts`; every route is a row in `routes/ROUTES.md`. See its doc.
- `ws/` — the single `upgrade` dispatcher (`wsServer.ts`) + endpoint builders under `ws/endpoints/`. See its doc.
- `wsOriginAllowlist.ts` — CSWSH defence: the one browser-`Origin` allowlist shared by `ws/wsServer.ts` and the executor's `terminalServer/websocket.ts`.
- `restartDrain/` — backend half of the dev-runner restart handshake (drain, settle, flush, lock-holder report). See its doc.
- `recovery.ts` / `recovery/` — boot recovery: tasks.json restore, snapshots, orphan worktrees, queued runs, workflow / one-off / merge-run resume. See its doc.
- `globalSettings.ts` / `globalSettings/` — `~/.lattice/globalSettings.json` read/write facade; field validators live beside their shapes. See its doc.
- `userSettings.ts` / `userSettings/` — per-project `<project>/.lattice/userSettings.json` barrel. See its doc.
- `serializeWrites.ts` — `runExclusive(key, fn)`: per-key promise chain so overlapping settings read-modify-writes can't clobber each other.
- `fsAtomic.ts` — `atomicWriteFile`: THE crash-safe temp→rename writer (retries transient Windows locks, never leaks its temp). Use it for every JSON store/config write.
- `emitter.ts` — `createEmitter(label)`: THE in-process pub/sub (snapshot iteration, per-listener isolation, `listeners.<label>` memory gauge). Use it instead of a hand-rolled listener `Set`.

## Project identity & state

- `projectPath.ts` — single source of truth for per-project paths under `~/.lattice/` (`canonicalProjectPath`, `projectHash`, `homeProjectDir`, …) + the `isRealAbsoluteProjectPath` route guard.
- `projectIdentity.ts` / `projectIdentity/` — realpath identity + durable legacy-hash bindings behind `projectPath.ts`, so path aliases share one store. See its doc; rationale in `PROJECT_IDENTITY.md`.
- `projectStateManager.ts` / `projectState/` — generic per-project cached, debounced-persisted state store (tasks, workflows, merge runs, terminal registry). See its doc.
- `projectInit.ts` / `projectInit/` — "Set up Git": `git init` a non-repo folder into a usable project. See its doc (two invariants).
- `ids.ts` — task / workflow / terminal-session id generators.

## Tasks, merge & runs

- `tasks.ts` / `taskCache/` — `tasks.ts` is the facade (the name predates the folder): the in-memory task cache + debounced `per-project/<hash>/tasks.json` persistence. See `taskCache/CLAUDE.md`.
- `taskSpawnEvents.ts` — `task-spawned` / `task-spawn-failed` pub/sub: a queued run's pty (or its non-CAP failure) reaches the UI over `/ws/tasks`.
- `taskVerification.ts` — renders `taskAgentTypecheck`: task agents run no tests/builds/type-checks, stated in the brief AND the system prompt.
- `worktree.ts` / `worktree/` — git-worktree subsystem: setup, merge, `projectGit`, `gitBackup`, disk guard, snapshots. See its doc.
- `mergeRuns.ts` / `mergeRuns/` — "merge all" engine: public singleton + worker loop in the facade, state/preflight/per-target helpers in the folder. See its doc.
- `mergeLocks.ts` — in-process per-task merge lock so a manual `/merge` can't race the run worker.
- `projectRunLock.ts` / `projectRunLock/` — cross-process per-project `run.lock` (labels, lendability, `inspectProjectRunLock`). See its doc.
- `diskPressureMerge.ts` — starts a merge run when task runs wait on disk, plus the once-a-minute low-disk monitor (opt-out `autoMergeOnLowDisk: false`).
- `workflows.ts` / `workflows/` — workflow definitions (`<project>/.lattice/workflows.json`) + `{{var}}` interpolation. See its doc.
- `workflowRuns.ts` / `workflowRuns/` — workflow-run engine (step groups in order; adjacent `parallel: true` planning steps run as one group). See its doc.
- `workflowPromptCustomizations.ts` / `workflowPromptCustomizations/` — spawn a harness to tailor a workflow step prompt. See its doc.
- `homeScratch/` — shared home-scoped scratch contract (path guard, session setup, bounded cleanup, persistence) for push / QA / post-merge runs. **Path-guard / cleanup changes go here.** See its doc.
- `pushRuns.ts` / `pushRuns/` — one-off push sessions: QA-lane Push (brief `push`) and workflow Push (brief `workflow-push`). See its doc.
- `qaRuns.ts` / `qaRuns/` — QA-lane Playwright e2e sessions; a confident PASS promotes qa → done. See its doc.
- `postMergeHooks.ts` / `postMergeHooks/` — optional per-project post-merge harness that gates merge completion on its callback. See its doc.
- `deadCode.ts` — distils the health analyzer's reachability into confidently-dead files for `GET /api/health/dead-code` and the `LATTICE_TASK.md` note.

## Agents & harness commands

- `harnesses.ts` — the `AgentHarness` vocabulary (from `shared/harnesses.ts`) + `agentHarnessForCommand`; never open-code a harness union.
- `shared/` — code the FRONTEND imports too (harness vocab + Pi model pattern, search wildcard, `{{var}}` grammar, tab labels, wire types). Relative imports only. See its doc.
- `harnessDetect.ts` — PATH probe for installed agent CLIs → `/ws/harnesses`; memoizes only definitive results (a timed-out probe is reported unavailable, never cached, and re-probed in the background).
- `agentCommandBuilder.ts` — shared harness command syntax: permission-bypass flags, Pi `--approve` + validated `--model`, shell quoting.
- `spawnQueue.ts` / `spawnQueue/` — admission controller in front of every agent spawn (`softCap` = `maxConcurrentAgents`; defers, never drops). See its doc.
- `queuedCreateSession.ts` — spawn-queue-gated `proxyCreateSession` for sites that await their pty (resolvers, one-off runs).
- `concurrencyLimit.ts` — tiny FIFO bounded-concurrency gate (e.g. the health watcher's file reads).
- `instructionTemplates.ts` / `instructionTemplates/` — editable agent-brief templates with `{{token}}`s + per-project overrides. See its doc.
- `harnessSystemPrompts.ts` / `harnessSystemPrompts/` — per-harness system-prompt Append/Replace + the always-on Lattice preamble, injected at the spawn chokepoint. See its doc.
- `latticeApiDocs.ts` / `latticeApiDocs/` — generates `<project>/.lattice/LATTICE_API.md` (short index, size-budgeted by test) + `LATTICE_API_RECIPES.md` from `*.template.md`. **Never import `latticeApiDocs.ts` from terminal-server code** (use `latticeApiDocs/docPath.ts`): every API tweak would mark the executor stale.
- `claudeStopHook.ts` — renders `.claude/settings.local.json` Stop + activity hooks for worktrees and non-worktree sessions (via the callback script).
- `codexStopHook.ts` — `.codex/hooks.json` Stop + activity hooks (if-absent write: only `ENOENT` counts as absent, so a repo's own file is never clobbered).
- `piExtension.ts` / `piExtension/` — Pi's `lattice-complete.ts` completion backstop (`session_shutdown` → callback). See its doc.
- `callbackOutbox.ts` / `callbackOutbox/` — durable completion callbacks: `lattice-callback.cjs`, the outbox, replay after a restart. See its doc.
- `claudeTrust.ts` / `claudeTrust/` — writes `~/.claude.json` folder trust + managed MCP entries (apply side only). See its doc.
- `claudeConfigGuard.ts` — backup/restore policy for a `~/.claude.json` truncated by a force-killed Claude (boot, periodic, post-kill).
- `agentQuiescence.ts` — per-session live-subagent / last-signal tracker behind the workflow-step and post-merge-hook Stop-hook gates (`*/stopHookGate.ts`).

## Activity hooks (graph beams + subagent satellites)

- `claudeHookBody.ts` — shared parsing of Claude-shaped hook POST bodies.
- `hookFiles.ts` — which file(s) a hook body names, per harness (Claude `file_path`; Codex `apply_patch` headers + existence-checked shell reads).
- `codexCodeActivity.ts` — reads literal shell/patch arguments from hosted Codex `exec` scripts without executing JavaScript; used by the worktree activity fallback in `terminalRegistry/codexTaskActivity.ts`.
- `activityHook.ts` — route-neutral decode into file activity or `SubagentStart`/`SubagentStop` lifecycle, shared by all three activity routes.
- `taskActivityEvents.ts` — `task-activity` pub/sub for worktree agents (`routes/tasks/activity.ts` → `/ws/tasks`).
- `agentSessions.ts` — presence registry for non-worktree / project-instrumented sessions (register at spawn, unregister at callback) → `/ws/agent-sessions`.
- `agentActivity.ts` — `agent-activity` pub/sub (file beams) for those sessions, fed by `routes/agentActivity.ts`.
- `agentActivityTokens.ts` — HMAC token minted into `/api/agent-activity/:token` hook URLs; secret persisted under `~/.lattice`.
- `piActivity.ts` / `piActivity/` — generates Pi's `.pi/extensions/lattice-activity.ts`, posting Claude-shaped bodies from `tool_execution_start/end`. See its doc.
- `projectClaudeHooks.ts` — merge-installs activity hooks into the project's own `.claude/settings.local.json`; never overwrites an unparseable or unreadable file (only `ENOENT` is absent).
- `projectCodexHooks.ts` — Codex analogue for user-opened Codex tabs: per-launch `--config hooks.*` overrides + `--dangerously-bypass-hook-trust`; nothing written to the repo or `~/.codex`.
- `projectClaude/` — project-root Claude instrumentation behind `routes/projectClaude.ts`: hook reconcile, session presence lifecycle, activity fan-out. See its doc.

## Terminal (detached PTY executor)

- `terminal-server.ts` / `terminalServer/` — the detached executor's entry + routes, WS, guards, shutdown. See its doc.
- `terminal.ts` / `terminal/` — the executor's pty-session core (create, attach, kill, scrollback, output facts). See its doc.
- `terminalConfig.ts` — executor tunables (scrollback replay / flush / on-disk log sizes).
- `terminalProtocol.ts` — wire protocol version, capability flags, session-request age limits shared by both processes.
- `terminalServerAuth.ts` — persisted bearer token guarding the executor's mutating HTTP routes (`x-lattice-terminal-token`).
- `persistedSecretFile.ts` — load-or-create for `~/.lattice` secrets (terminal token, `agentTokenSecret`): regenerates only on ENOENT (exclusive `wx` create) or an unusable value — **never overwrite a secret you couldn't read** (running executors / baked hook tokens still hold it).
- `terminalFingerprint.ts` — hash of the executor's source bytes; every file the executor imports must be in `FINGERPRINT_FILES`.
- `terminalServerLifecycle.ts` — spawn / respawn / health probe of the executor. Only a refused connection is absence; a probe timeout (executor busy spawning ptys) is re-probed for up to 10 s — never a spawn beside it, never an instant spawn failure.
- `terminalServerStatus.ts` — read-only `current|stale|absent|unavailable` for the navbar "update pending" chip; never triggers the upgrade itself.
- `terminalServerClient.ts` / `terminalServerClient/` — backend HTTP client for the executor (probes, kills, the `POST /sessions` spawn chokepoint). See its doc.
- `terminalProxy.ts` — public façade over lifecycle + client + `terminalWsRelay.ts`; its kill wrappers end terminal-registry records.
- `terminalWsRelay.ts` — relays browser `/ws/terminal` to the executor.
- `terminalBanner.ts` — the dim scrollback banner naming `LATTICE_API.md`; tells the user, never reaches the agent.
- `terminalRegistry.ts` / `terminalRegistry/` — durable terminal-tab registry + restore-on-open. See its doc.
- `terminalActivity.ts` — per-tab "agent still working" signal (`/ws/terminal-activity`): Codex status title, Claude/Pi sustained printable output.
- `terminalActivityPoller.ts` — the shared **display-only** poll (generation fencing, 5 s staleness expiry); never affects pty/task/workflow liveness.
- `terminalActivityRelay.ts` — browser-stream title facts, only for old executors lacking `capabilities.nativeTerminalTitle`.
- `codexTerminalActivity.ts` — per-launch Codex `-c` defaults: status-only terminal title + `tui.terminal_resize_reflow_max_rows` (500).
- `processTree.ts` — the one home for process-tree kills (don't add another): Windows `taskkill /F /T` after `pty.kill`, and shell-aware `killChildTree`.
- `nodePtyCleanupFailure.ts` — recognizes the one ignorable Windows node-pty cleanup `TypeError` (by stack frame, not message alone).

## Git watchers, search & graph

- `gitBranch.ts` — navbar branch label + read-only `.git/HEAD` watcher (`/ws/git-branch`); `rearmGitBranchWatcher` is called by `projectInit` after `git init`.
- `gitStatus.ts` — read-only git-dir + working-tree watchers → status signature (`/ws/git-status`); the git-dir watcher prunes `objects`/`lfs`/`worktrees`/`logs` (`createGitMetaIgnored`); `computeStatusSignature` never rejects.
- `gitWatcherRegistry.ts` — one lazy watcher set per canonical root shared by all subscribers (isolated fan-out, `rearm`). **Slots live for the process lifetime** (no close on last unsubscribe — avoids churn on WS reconnect storms), bounded by distinct roots; always key by `canonicalProjectPath` — a new path spelling adds a duplicate set of recursive watchers.
- `gitDir.ts` — `resolveGitDir`: walks up like git and follows a worktree's / submodule's `.git` pointer file (`gitdir: <path>`), so watchers watch the real git dir.
- `gitHistory.ts` / `gitHistory/` — the timeline scrubber's `git log`, ghost-node `deletedPaths`, status signature. See its doc.
- `watchTree.ts` / `watchTree/` — win32 recursive `fs.watch` (one handle) replacing chokidar's per-dir handles, which locked directories; `LATTICE_WATCH_MODE` overrides; symlinks not followed. See its doc.
- `search.ts` / `search/` — file-contents search for `/api/search` (absolute paths = graph node ids; wildcard grammar in `shared/searchPattern.ts`). The JS fallback (`search/jsGrepWorker.ts`) greps in a worker with a wall-clock budget, so a ReDoS user regex can't freeze the event loop. See its doc.
- `ripgrep.ts` — optional memoized `rg` fast path for `search.ts` (`LATTICE_DISABLE_RG`, `LATTICE_RG_PATH`).
- `scanner/` — project → `{nodes, links}` graph pipeline (no facade: import the phase module, e.g. `scanner/scan.ts`). See its doc.
- `health.ts` / `health/` — tree-sitter per-file metrics, health score, cross-file dead code, file watcher. See its doc.
- `fsbrowse.ts` / `fsbrowse/` — folder-picker backend (roots, validation, listing, create-dir). See its doc.

## Pi / MCP / tools

- `piModels.ts` / `piModels/` — Pi model discovery/menu, models.json reconcile, endpoint probes. See its doc.
- `piProviderValidation.ts` — `PiProvider` types + validation of `globalSettings.piProviders` (re-exported from `globalSettings.ts`).
- `spawnWithTimeout.ts` — spawn + capture + kill-the-whole-tree-on-timeout for bounded external CLI calls (Pi, Opengrep).
- `piSubagents.ts` / `piSubagents/` — auto-installs `@tintinweb/pi-subagents` + cwd-exact shims (incl. the project root). See its doc.
- `piMcp.ts` / `piMcp/` — Pi MCP via `pi-mcp-adapter` (cwd `.pi/mcp.json` + shim written at spawn). See its doc.
- `mcp/` — MCP control plane: catalog, per-harness resolvers, secrets, import; resolved in the backend, applied by the executor. See its doc.
- `latticeMcp/` — Lattice's own first-party stdio MCP server over the task-board API. See its doc.
- `opengrep.ts` / `opengrep/` — Opengrep SAST as a user-installed pre-run tool; nothing third-party is committed or bundled. See its doc.

## Crash & logging

- `processGuards.ts` — swallows only the node-pty cleanup throw; anything else logs, writes a crash file and exits 1 (hard-exits if the console is stalled).
- `crashLog.ts` / `crashLog/` — console ring, sync `~/.lattice/logs/crash-*.log`, Node diagnostic report, `live-*.log` mirror promoted to `*-nojs.log` next boot (`liveMirror.ts`), newest-N retention per kind. Best-effort, never fatal. See its doc.
- `consoleSink.ts` — async, bounded (256 KB) console writes, so a stalled console (a Windows text selection) drops lines instead of freezing the process.
- `memDiag.ts` / `memDiag/` — periodic `[mem]` console line + `~/.lattice/logs/mem-*.jsonl` for backend, terminal-server and browser tabs; `registerMemGauge` beside every long-lived collection; `/api/debug/*`. See its doc.

## Misc

- `__tests__/` — node:test suite (named after the module it covers; cross-cutting guards listed in its doc).
- `PROJECT_IDENTITY.md` — why project paths resolve to one identity/store.
- `AGENTS.md` — pointer to `CLAUDE.md` for non-Claude harnesses.
