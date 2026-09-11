// Standalone terminal server. Runs as a detached child process owned
// separately from the main Lattice server so PTY sessions (and the Claude
// agents inside them) survive main server restarts.
//
// Spawned by the main server on startup via terminalProxy.ts.
// Binds to 127.0.0.1 only — not accessible from outside localhost.

import http from 'node:http';
import express from 'express';
import { ensureClaudeConfigValid } from './claudeConfigGuard.js';
import { pruneStaleClaudeProjectEntries } from './claudeTrust.js';
import { clearTerminalScrollback } from './terminal/scrollbackCleanup.js';
import { computeTerminalFingerprint } from './terminalFingerprint.js';
import { TERMINAL_SERVER_TOKEN_ENV } from './terminalServerAuth.js';
import { installTerminalProcessGuards } from './terminalServer/processGuards.js';
import { registerTerminalRoutes } from './terminalServer/routes.js';
import {
  createTerminalShutdown,
  wireTerminalShutdownSignals,
} from './terminalServer/shutdown.js';
import {
  attachTerminalWebSocketUpgrade,
  createTerminalWebSocketServer,
} from './terminalServer/websocket.js';
import { watchParentProcess } from './terminalServer/parentWatch.js';
import { createTerminalAdmission } from './terminalServer/admission.js';

installTerminalProcessGuards();

const TERMINAL_PORT_DEFAULT = 5185;
const CLAUDE_CONFIG_BACKUP_INTERVAL_MS = 60_000;
const STALE_CLAUDE_PROJECT_PRUNE_INTERVAL_MS = 5 * 60_000;

const PORT = Number(process.env.TERMINAL_PORT) || TERMINAL_PORT_DEFAULT;
const TERMINAL_AUTH_TOKEN = process.env[TERMINAL_SERVER_TOKEN_ENV] ?? '';
if (!TERMINAL_AUTH_TOKEN) {
  console.error(
    `[lattice-terminal] missing ${TERMINAL_SERVER_TOKEN_ENV}; refusing to expose terminal control routes`,
  );
  process.exit(1);
}

// Content-hash of the terminal-server's own runtime files (computed once at
// startup, frozen for the process lifetime). Replaces the hand-maintained
// TERMINAL_API_VERSION constant: any byte-level change to the listed files
// changes the fingerprint, so a stale orphan ALWAYS looks different from a
// freshly-spawned server. No human in the loop, no missed bumps.
const TERMINAL_FINGERPRINT = computeTerminalFingerprint();

const app = express();
const shutdown = createTerminalShutdown();
const admission = createTerminalAdmission();
registerTerminalRoutes(app, {
  fingerprint: TERMINAL_FINGERPRINT,
  shutdown,
  authToken: TERMINAL_AUTH_TOKEN,
  admission,
});

const server = http.createServer(app);
const wss = createTerminalWebSocketServer(admission);
attachTerminalWebSocketUpgrade(server, wss);

server.on('error', (err: NodeJS.ErrnoException) => {
  // Most likely cause: port already in use. Exit so the orchestrator can
  // detect the failure and the port isn't held by a half-started process.
  console.error(`[lattice-terminal] server error (${err.code}): ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[lattice-terminal] listening on port ${PORT} (fingerprint ${TERMINAL_FINGERPRINT})`,
  );
  // We now own the port, so any previous terminal-server has exited and every
  // session it held is gone (a stale-id attach gets session_lost). Its
  // per-session scrollback logs are therefore orphans — wipe the directory.
  // Done here (not before listen) so a failed listen on a port-conflict can't
  // clobber a still-running server's logs.
  clearTerminalScrollback();
  // Backup ~/.claude.json if valid, restore from backup if corrupt. Runs
  // once on startup so a Claude-prompt-blocking corruption from a previous
  // session is healed before any new pty is spawned.
  void ensureClaudeConfigValid({ refreshBackup: true });
});

// Periodic: refresh the backup while ~/.claude.json is healthy so the
// known-good copy stays close to current. The 60 s cadence is far slower
// than Claude's own writes, so we mostly observe stable state.
const claudeConfigInterval = setInterval(() => {
  void ensureClaudeConfigValid({ refreshBackup: true });
}, CLAUDE_CONFIG_BACKUP_INTERVAL_MS);
claudeConfigInterval.unref();

// Periodic: cap ~/.claude.json bloat from THIS long-lived process. Every spawn
// pre-seeds a `projects[<ephemeral-cwd>]` entry; the boot-time
// `sweepStaleClaudeProjectEntries` only prunes them at main-backend startup, but
// the terminal-server outlives many such restarts and is the thing accumulating
// them (a real pile reached 246 entries / 770KB). A bigger file means Claude's
// in-place shutdown rewrite takes longer, widening the window for a force-kill
// to truncate it — the root corruption cause. Pruning dead-dir entries here
// keeps the file (and that window) small between boots. Off the hot path: a
// 5-min cadence, never the per-spawn write. Goes through the same config lock,
// so it can't race a spawn-time write.
const claudeConfigPruneInterval = setInterval(() => {
  void pruneStaleClaudeProjectEntries();
}, STALE_CLAUDE_PROJECT_PRUNE_INTERVAL_MS);
claudeConfigPruneInterval.unref();

wireTerminalShutdownSignals(shutdown);

// Self-terminate if the spawning backend disappears. Forwarded by the
// main server's terminalServerLifecycle as `BACKEND_PARENT_PID`. Without
// this, an ungracefully-killed backend (Task Manager, parent-shell exit,
// OS reboot interrupt) leaves the detached terminal-server running with
// no one polling /shutdown and no fingerprint mismatch to trigger a
// respawn — exactly the "stray node process" symptom that requires
// killing all node processes by hand.
const parentPid = Number(process.env.BACKEND_PARENT_PID);
if (parentPid) {
  watchParentProcess(parentPid, () => {
    // Reuse the normal shutdown path so PTYs get reaped before exit.
    void shutdown();
  });
}
