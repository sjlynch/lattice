# backend/src/terminal

The detached terminal-server's internal PTY-session machinery. `../terminal.ts`
is the public facade that re-exports this surface; `../terminalServer/` drives
the HTTP/`/ws/terminal` plumbing on top of it. **Not** the frontend
`frontend/src/terminal/` dir (xterm UI state) — this is the server side that
owns the node-pty processes.

## Files

- `sessionTypes.ts` — `Session` (id, pty, scrollback, size, cwd, shell,
  projectPath, subscribers, `killing` guard) + `CreateOpts` / `AttachOpts`. No
  logic.
- `sessionStore.ts` — **the single source of truth**: the module-singleton
  `Map<id, Session>`. `getSession` / `addSession` / `deleteSession` (disposes
  the session's scrollback at the one deletion point) / `sessionCount` /
  `allSessions` / `listSessions` (debug snapshot).
- `launchContext.ts` — `buildSessionLaunchContext`: resolves shell, cwd
  (validated to exist — refusing a doomed spawn that would feed a reconnect
  loop), size, projectPath, and the env (Lattice breadcrumb vars +
  `$LATTICE_DOCS`); calls `windowsPath` + `envSetup` to shape PATH/overhead env,
  then routes the initial command through the per-harness command rewriters
  (`claudeSystemPrompt` + `codexTrust`).
  Shell resolution is `resolveDefaultShell(env, platform)` (exported, injectable
  for tests): per-spawn `opts.shell` → `LATTICE_DEFAULT_SHELL` env override (the
  detached terminal-server can't read settings files, so the escape hatch is
  env-based like `LATTICE_API_PORT`) → platform default (`COMSPEC`/cmd.exe on
  Windows, `$SHELL`/bash on POSIX). **The Windows default is cmd.exe**, where
  `$LATTICE_*` breadcrumbs don't expand — so the discovery banner names the doc
  by its literal absolute path (`terminalBanner.ts`) and the generated
  `LATTICE_API.md` bakes in literal values + per-shell (`$VAR` / `%VAR%` /
  `$env:VAR`) syntax rather than relying on shell expansion.
- `windowsPath.ts` — `applyFreshWindowsPath`: replace the inherited Windows PATH
  with a registry-read one (HKLM+HKCU) so tools installed after the long-lived
  terminal-server booted are visible. Read off the spawn path (cached, 30 s TTL,
  background refresh) — a synchronous `reg.exe` here once produced empty panes.
- `envSetup.ts` — `applyClaudeOverheadEnv`: default-in the
  `DISABLE_AUTOUPDATER`/`DISABLE_TELEMETRY`/… vars so each spawned Claude skips
  per-launch overhead (multiplied under fan-out). Defaults only — never
  overrides a value the user set.
- `codexTrust.ts` — recognizes Lattice-started `codex` initial commands and
  injects Codex's one-shot `--config projects.<cwd>.trust_level='trusted'`
  override. The dynamic TOML value rides in the child PTY environment with
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
  check → `buildSessionLaunchContext` → `pty.spawn` → build `Session` →
  `addSession` → `wireSessionPtyEvents` + banner + initialCommand).
  `precreateSession` is the no-subscriber variant route handlers use to return a
  `serverId` before any WS attaches.
- `sessionLifecycle.ts` — `wireSessionPtyEvents` (pty `onData` →
  scrollback.append + broadcast; pty `onExit` → broadcast `exit`, close
  subscribers, `deleteSession`), plus `addLatticeBanner` and
  `scheduleInitialCommand`.
- `broadcast.ts` — `broadcastToSubscribers`: fan a message out to every OPEN
  subscriber WS, best-effort.
- `attach.ts` — `attachTerminal`: resolve an existing session by id (or create a
  fresh one when no id), add the WS as a subscriber, send `attached` + the
  scrollback replay, then relay input/resize/kill messages. An unknown id sends
  `session_lost` and does **not** silently respawn (that would be a reconnect
  loop). A client disconnect drops the subscriber but leaves the pty alive
  (refresh-recovery).
- `kill.ts` — `killSession` (idempotent via the `killing` flag; `pty.kill` +
  Windows process-tree kill + a deferred `ensureClaudeConfigValid`) and
  `killSessionsByCwd` (used by worktree teardown).
- `scrollbackStore.ts` — the disk-backed replay concern: a per-session append
  log under `~/.lattice/terminal-scrollback` so a large replay window stays off
  the heap, degrading to a bounded in-memory tail if disk is unavailable. Owns
  the pending-buffer/degraded-mode state machine (append/flush/compact/replay);
  the low-level file mechanics and the boot-time wipe live in the two helpers
  below.
- `scrollbackLogFile.ts` — pure, stateless file-tail helpers `trimToLineStart`
  (drop a partial leading line so a windowed replay never begins mid-escape-
  sequence) and `readTail` (byte-level last-`maxBytes` read, trimmed to a line
  boundary). Used by `ScrollbackStore` for both replay and inline compaction.
- `scrollbackCleanup.ts` — `clearTerminalScrollback`: wipes the scrollback dir
  at boot (every in-memory session is gone after a restart, so its logs are
  orphans). Path-guarded to the home-scoped `~/.lattice/terminal-scrollback` so
  it can never touch a project tree.

## Flow

- **create:** `createSession` → `buildSessionLaunchContext`
  (`launchContext`/`envSetup`/`windowsPath` set up shell/cwd/env) → `pty.spawn`
  → `wireSessionPtyEvents` (`sessionLifecycle`) → `addSession` (`sessionStore`).
- **attach:** `attachTerminal` → `getSession`-or-`createSession` → add WS
  subscriber → send `attached` + scrollback replay.
- **kill / pty exit:** `killSession` or the pty `onExit` handler →
  `broadcastToSubscribers` (`exit`) → `deleteSession` (which disposes the
  scrollback).
