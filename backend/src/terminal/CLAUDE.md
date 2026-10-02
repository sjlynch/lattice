# backend/src/terminal

The detached terminal-server's internal PTY-session machinery. `../terminal.ts`
is the public facade that re-exports this surface; `../terminalServer/` drives
the HTTP/`/ws/terminal` plumbing on top of it. **Not** the frontend
`frontend/src/terminal/` dir (xterm UI state) — this is the server side that
owns the node-pty processes.

## Codex launch defaults

The main backend owns these defaults in
[`withCodexActivityTitle`](../codexTerminalActivity.ts), injected through
[`terminalServerClient/spawnBody.ts`](../terminalServerClient/spawnBody.ts)
for pre-spawns and [`terminalWsRelay.ts`](../terminalWsRelay.ts) for connects
without a session id. It inserts per-launch `tui.terminal_title=['status']`
and `tui.terminal_resize_reflow_max_rows=CODEX_RESIZE_REFLOW_MAX_ROWS` (500)
right after the executable. Injection is idempotent, upgrades earlier
title-only commands on relaunch, and leaves later explicit user overrides
effective without writing user Codex config.

Lattice can inherit `WT_SESSION` from its dev server. Codex's observed Windows
Terminal default re-emits up to 9001 transcript rows on each resize, taking
minutes through PTY → relay → xterm. The cap and frontend resize debounce
prevent that regression.

Codex Working state follows its status title rather than animated idle output;
[`../terminalActivity.ts`](../terminalActivity.ts) owns classification. Preserve
live PTYs: these defaults apply on launch/relaunch, never by killing sessions
to upgrade them.

## Scrollback and session caps

The values live in `TERMINAL_CONFIG` in
[`../terminalConfig.ts`](../terminalConfig.ts):

- `SCROLLBACK_REPLAY_BYTES` (2_000_000) — the most a browser receives per
  attach or reconnect.
- `SCROLLBACK_KEEP_BYTES` (4_000_000) — the tail a compaction keeps.
- `SCROLLBACK_MAX_DISK_BYTES` (8_000_000) — the on-disk log size that
  triggers a compaction.
- `SCROLLBACK_FLUSH_BYTES` (64_000) — pending in-memory output before a flush
  to the log.
- `MAX_TERMINAL_SESSIONS` (200) — `createSession`'s runaway backstop on live
  ptys.

Every mounted browser pane receives up to `SCROLLBACK_REPLAY_BYTES` on each
(re)attach, and JSON-escaping control characters inflates the frame beyond
that. Raising the constant therefore multiplies browser memory per pane.

## Files

- `sessionTypes.ts` — `Session` (id, pty, scrollback, size, cwd, shell,
  projectPath, subscribers, `lastOutputAt`, `outputFacts`, `initialCommand`,
  `killing` guard) + `CreateOpts` / `AttachOpts`. Record facts here; activity
  thresholds and harness classification stay in `../terminalActivity.ts`.
- `outputFacts.ts` — constant-memory incremental escape parser recording
  `lastTextOutputAt` and the latest `terminalTitle` (OSC 0/2, at most 128 code
  units; oversized/malformed titles become unknown). CSI synchronization/cursor/query frames, OSC titles and
  DCS/APC/PM payloads do not count as text, even across PTY chunks. Codex emits
  synchronized-redraw controls repeatedly while waiting for input. Raw output
  still reaches scrollback/subscribers unchanged, and `lastOutputAt` retains
  its raw-byte meaning for existing liveness consumers. Zero text timestamp
  means no printable output yet. `isGround` lets the backend relay skip title
  parsing for plain output while preserving pending split escape sequences.
  The main backend can derive titles from existing browser streams if an old
  executor lacks the native field (`../terminalActivityRelay.ts`).
- `sessionStore.ts` — **the single source of truth**: the module-singleton
  `Map<id, Session>`. `getSession` / `addSession` / `deleteSession` (disposes
  the session's scrollback at the one deletion point) / `sessionCount` /
  `allSessions` / `listSessions` (debug snapshot — also the wire format the
  main backend reads output timestamps, `terminalTitle` and `initialCommand` from).
- `launchContext.ts` — `buildSessionLaunchContext`: resolves shell, cwd
  (validated to exist — refusing a doomed spawn that would feed a reconnect
  loop), size, projectPath, and the env; calls `windowsPath` + `envSetup` to
  shape PATH/overhead env, then routes the initial command through the
  per-harness command rewriters (`claudeSystemPrompt` + `codexTrust`). It also
  looks up `<project>/.lattice/LATTICE_API.md` (`../latticeApiDocs/docPath.ts`)
  and hands the path to the banner — it does NOT generate it: the generator and
  its templates change with every API edit, and in this process's fingerprinted
  import graph they marked the live terminal-server stale each time. The main
  backend regenerates the doc before it requests a session
  (`resolveHarnessSpawnBody`, and `terminalWsRelay.ts` for a serverless
  connect). **It plants no `LATTICE_*` breadcrumb env vars** — it used to export
  `LATTICE_API_URL`/`LATTICE_PROJECT`/`LATTICE_PROJECT_HASH`/`LATTICE_DOCS`
  "so agents could discover the API", but no harness reads the environment
  into its context, so nothing ever saw them. Agent-facing discovery is the
  system-prompt preamble the backend injects at the spawn chokepoint
  (`harnessSystemPrompts/latticePreamble.ts`).
  Shell resolution is `resolveDefaultShell(env, platform)` (exported, injectable
  for tests): per-spawn `opts.shell` → `LATTICE_DEFAULT_SHELL` env override (the
  detached terminal-server can't read settings files, so the escape hatch is
  env-based like `LATTICE_API_PORT`) → platform default (`COMSPEC`/cmd.exe on
  Windows, `$SHELL`/bash on POSIX). **The Windows default is cmd.exe**, where a
  `$VAR` reference does not expand at all — which is why the generated
  `LATTICE_API.md` bakes in literal values (API URL, project path, its
  forward-slash form, project hash) and why the human-facing banner
  (`terminalBanner.ts`) names the doc by its literal absolute path.
- `windowsPath.ts` — `applyFreshWindowsPath`: replace the inherited Windows PATH
  with a registry-read one (HKLM+HKCU) so tools installed after the long-lived
  terminal-server booted are visible. Read off the spawn path (cached, 30 s TTL,
  background refresh) — a synchronous `reg.exe` here once produced empty panes.
  Also `applyPtyPathPrepend`: `LATTICE_PTY_PATH_PREPEND` dirs go first on every
  terminal's PATH, ahead of the registry PATH (which otherwise outranks anything
  merely inherited from the second spawn on). An operator escape hatch for
  wrapping a harness CLI; the self-hosting soak (`scripts/soak/`) uses it to put
  its fake `claude` first.
- `envSetup.ts` — `applyClaudeOverheadEnv`: default-in the
  `DISABLE_AUTOUPDATER`/`DISABLE_TELEMETRY`/… vars so each spawned Claude skips
  per-launch overhead (multiplied under fan-out). Defaults only — never
  overrides a value the user set. Also `scrubInheritedNpmEnv`: strip the npm
  run-script context Lattice's own boot leaks in. **Lattice's backend is itself
  an npm run-script and every pty inherits the backend's environment wholesale**,
  so `npm_config_prefix` — npm's "where global items get installed" — reached
  every terminal in every project and silently redirected `npm install -g` into
  `<latticeRoot>/backend`: shims landed beside the repo's own files (untracked,
  outside the `node_modules/` ignore rule), the package was NOT on PATH so it
  looked like it hadn't installed, and the next `npm install` there pruned it as
  extraneous. `scripts/orchestrate/config.mjs` removes the cause (cwd, not
  `npm --prefix`); this is the boundary defence. It is deliberately **not** a
  blanket `npm_config_*` scrub — `registry`/`cache`/`_authToken` may be the
  user's own ambient config, and dropping those would break private-registry
  installs inside Lattice terminals only. It also reverses npm's PATH injection
  (npm prepends `node_modules/.bin` for the package it runs and every ancestor),
  which had lent every terminal Lattice's own `tsc`/`tsx`/`esbuild`/`playwright`
  — not overriding a correct tool but inventing one, so an agent in a project
  that hasn't installed TypeScript got a meaningless clean type-check instead of
  "command not found". Rather than guess which entries look like Lattice's (a
  hardcoded layout that can drift), it derives npm's exact injected set from
  `npm_config_local_prefix` and removes only those — no knowledge of where
  Lattice is installed, and a correct no-op when Lattice was started without npm.
  All of it runs before `applyFreshWindowsPath` so the registry PATH is still
  merged over what's left. npm re-injects the `.bin` entries for any script IT
  runs, so `npm run` is unaffected; only commands typed at the prompt change.
  `__tests__/inheritedNpmEnv.test.ts` covers both halves and ends with an
  end-to-end guard that drives the real `buildSessionLaunchContext` against a
  poisoned `process.env` — it fails if the call is removed, reordered after
  `applyFreshWindowsPath`, or if a new leak of the same shape appears.
- `codexTrust.ts` — recognizes Lattice-started `codex` initial commands and
  injects Codex's one-shot `--config projects={'<cwd>'={trust_level='trusted'}}`
  override. The path is an inline-table key in the VALUE because Codex splits a
  `-c` KEY on every `.` and keeps quotes in the segment (every worktree path
  has `.lattice` in it); it is a single-quoted literal (`tomlString`, which
  lives here and is re-exported by `mcp/codexServerConfig.ts`) because cmd's
  `"%VAR%"` strips inner double quotes. A table-valued `projects` override is
  merged over the user's `[projects]`, not a replacement. The dynamic TOML
  value rides in the child PTY environment with
  shell-specific expansion syntax, so paths are not interpolated into shell
  source. This trusts the cwd only for that Codex process and never writes the
  user's `~/.codex/config.toml`. Also home to the shared `--config`-injection
  helper (`applyCodexConfigArgs`, exported `shellEnvRef`) and its two consumers:
  `configureCodexProjectMcp` (managed MCP overrides) and
  `configureCodexSystemPrompt` (the per-project system-prompt override —
  `developer_instructions`/`model_instructions_file`, on its own
  `LATTICE_CODEX_SYS_<i>` env-var series so it coexists with MCP).
- `claudeSystemPrompt.ts` — the Claude analogue: rewrites a Lattice-started
  `claude` command to add `--system-prompt-file` (replace) / `--append-system-
  prompt-file` (append) for the per-project harness system-prompt override. The
  backend wrote the prompt to a scratch file and shipped its path; the path
  rides a child-env var referenced via `shellEnvRef` (never shell source),
  mirroring codexTrust. No-op for non-Claude commands / no override. See
  `harnessSystemPrompts/`.
- `createSession.ts` — `createSession`: the spawn orchestrator (session-cap
  check against `MAX_TERMINAL_SESSIONS` → `buildSessionLaunchContext` → `pty.spawn` → build `Session` →
  `addSession` → `wireSessionPtyEvents` + banner + `lowerAgentPriority` +
  initialCommand). `lowerAgentPriority` sets an **agent** pty's shell
  (`agentHarnessForCommand(initialCommand)`) to below-normal priority *before*
  the agent command is typed, so everything the agent spawns (test runners,
  bundlers) inherits it — a dozen agents on a large repo pinned every core and
  froze the desktop at equal priority (2026-09-22). User shells / dev servers
  keep normal priority; `LATTICE_AGENT_PRIORITY=normal` opts out.
  `precreateSession` is the no-subscriber variant route handlers use to return a
  `serverId` before any WS attaches.
- `sessionLifecycle.ts` — `wireSessionPtyEvents` (pty `onData` → stamp
  `lastOutputAt` + scrollback.append + broadcast; pty `onExit` → broadcast
  `exit`, close subscribers, `deleteSession`), plus `addLatticeBanner` and
  `scheduleInitialCommand`. **The banner is human-only**: it is appended to the
  session SCROLLBACK (the browser's replay buffer), never written to the pty,
  so no harness can read it. Don't "fix" agent discovery here — that lives in
  the system-prompt preamble.
- `broadcast.ts` — `broadcastToSubscribers`: fan a message out to every OPEN
  subscriber WS, best-effort. **Backpressure:** a subscriber whose
  `bufferedAmount` passes `SUBSCRIBER_HIGH_WATER_BYTES` (8 MB) is
  `terminate()`d instead of buffered further — this process hosts every pty,
  so one browser tab that stopped reading must not grow its heap (the client
  reconnects and gets the replay). Also `holdSubscriber` / `releaseSubscriber`:
  a socket on hold has its frames queued (same bound) for `attachTerminal` to
  flush after the replay.
- `attach.ts` — `attachTerminal`: resolve an existing session by id (or create a
  fresh one when no id), add the WS as a subscriber **on hold**, send
  `attached`, wire the input/resize/kill handlers, then read the scrollback
  replay asynchronously (`replayAsync`) and send it followed by the held live
  frames in order — the replay was a synchronous up-to-2 MB
  (`SCROLLBACK_REPLAY_BYTES`) read on the loop every pty shares, and N
  re-attaches after a backend restart pushed the health probe past its timeout.
  Attach always sends a `data` frame with `replayed: true` for history, including
  empty/failed reads, before held live frames. The browser suppresses historical
  terminal-query replies; omitting the empty boundary could misclassify a live
  startup query as history. `kill` goes through `killSession` (the `killing`
  guard + process-tree kill), never a bare `pty.kill()`. Sizes are validated
  with `isPtyDimension` (positive integer, at most 32767 — ConPTY's 16-bit limit)
  here and in the upgrade handler. A malformed upgrade target (one `new URL()`
  rejects) is refused, never thrown — a throw there would exit the executor. An
  unknown id sends `session_lost` and does **not** silently respawn (that would
  be a reconnect loop). A client disconnect drops the subscriber but leaves the
  pty alive (refresh-recovery).
- `ptyDimension.ts` — dependency-free `isPtyDimension` / `MAX_PTY_DIMENSION` (re-exported by `attach.ts`), so the main backend's `routes/terminals.ts` can share it without loading node-pty.
- `kill.ts` — `killSession` (idempotent via the `killing` flag; `pty.kill` +
  Windows process-tree kill + a deferred `ensureClaudeConfigValid`) and
  `killSessionsByCwd` (used by worktree teardown). Its `cwdIsAtOrUnder`
  predicate is separator-agnostic and case-folds only on win32 — the same
  comparison the backend's own "is a pty alive under this worktree" checks
  (`mergeRuns/waiterLiveness.ts`, `recovery/liveSessions.ts`) make, so the two
  can never disagree about which ptys a teardown kills.
- `scrollbackStore.ts` — the disk-backed replay concern: a per-session append
  log under `~/.lattice/terminal-scrollback` so a large replay window stays off
  the heap, degrading to a bounded in-memory tail if disk is unavailable. Owns
  the pending-buffer/degraded-mode state machine (append/flush/compact/replay);
  the low-level file mechanics and the boot-time wipe live in the two helpers
  below. **Compaction is asynchronous** (temp file + rename via `fs.promises`):
  its read-4-MB + write-4-MB (`SCROLLBACK_KEEP_BYTES`, triggered past
  `SCROLLBACK_MAX_DISK_BYTES`) used to run synchronously on this event loop —
  which hosts every pty — so thirty agents each crossing the disk cap froze
  all of them in turn. While a compaction is in flight, flushes hold output in
  `pending` (bounded to the replay window) and land after the rename; `replay`
  appends that held tail. `settle()` awaits it (tests). The rename runs on a
  worker thread, so on Windows it can collide with a concurrent replay's read
  holding the log open (EPERM/EBUSY): it is retried a
  few times, and if it still fails the OLD log is kept (complete, merely over
  the cap) with a 5 s cooldown before the next crossing retries — never a drop
  to memory-only, which is reserved for a genuinely unavailable disk.
  **`replayAsync` is what attach uses**: it snapshots the flushed length and
  held pending synchronously, then reads the tail off the loop capped at that
  length, so output appended meanwhile (which the attaching client receives
  as held live frames) is never in the replay too. With a compaction already
  in flight it takes the sync `replay()` path (consistent by construction).
- `scrollbackLogFile.ts` — pure, stateless file-tail helpers `trimToLineStart`
  (drop a partial leading line so a windowed replay never begins mid-escape-
  sequence) and `readTail` (byte-level last-`maxBytes` read, trimmed to a line
  boundary) plus its async twin `readTailAsync(file, maxBytes, endOffset?)`.
  `ScrollbackStore` uses the async form for both replay and compaction; the
  sync form is the in-flight-compaction fallback and the test helper.
- `scrollbackCleanup.ts` — `clearTerminalScrollback`: wipes the scrollback dir
  at boot (every in-memory session is gone after a restart, so its logs are
  orphans). Path-guarded to the home-scoped `~/.lattice/terminal-scrollback` so
  it can never touch a project tree.

## Flow

- **create:** `createSession` → `buildSessionLaunchContext`
  (`launchContext`/`envSetup`/`windowsPath` set up shell/cwd/env) → `pty.spawn`
  → `addSession` (`sessionStore`) → `wireSessionPtyEvents` (`sessionLifecycle`).
- **attach:** `attachTerminal` → `getSession`-or-`createSession` → add WS
  subscriber → send `attached` + scrollback replay.
- **kill / pty exit:** `killSession` or the pty `onExit` handler →
  `broadcastToSubscribers` (`exit`) → `deleteSession` (which disposes the
  scrollback).

## Commands

From `backend/`: `npm run build` (compile/copy assets), `npm test` (backend
tests), `npx tsc --noEmit` (type-check).
