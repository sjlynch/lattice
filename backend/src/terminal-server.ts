// Standalone terminal server. Runs as a detached child process owned
// separately from the main Lattice server so PTY sessions (and the Claude
// agents inside them) survive main server restarts.
//
// Spawned by the main server on startup via terminalProxy.ts.
// Binds to 127.0.0.1 only — not accessible from outside localhost.

import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { attachTerminal, killSession, killSessionsByCwd, listSessions, precreateSession } from './terminal.js';
import { computeTerminalFingerprint } from './terminalFingerprint.js';
import { ensureClaudeConfigValid } from './claudeConfigGuard.js';

// Same node-pty Windows cleanup guard as the main server. Must be registered
// before any PTY session can throw asynchronously.
process.on('uncaughtException', (err) => {
  const stack = err instanceof Error && err.stack ? err.stack : String(err);
  if (stack.includes('node-pty')) {
    console.warn(
      '[lattice-terminal] swallowed node-pty error (pty cleanup):',
      err instanceof Error ? err.message : err,
    );
    return;
  }
  console.error('[lattice-terminal] uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  const stack =
    reason instanceof Error && reason.stack ? reason.stack : String(reason);
  if (stack.includes('node-pty')) {
    console.warn(
      '[lattice-terminal] swallowed node-pty rejection:',
      reason instanceof Error ? reason.message : reason,
    );
    return;
  }
  console.error('[lattice-terminal] unhandledRejection', reason);
});

const PORT = Number(process.env.TERMINAL_PORT) || 5185;

// Content-hash of the terminal-server's own runtime files (computed once at
// startup, frozen for the process lifetime). Replaces the hand-maintained
// TERMINAL_API_VERSION constant: any byte-level change to the listed files
// changes the fingerprint, so a stale orphan ALWAYS looks different from a
// freshly-spawned server. No human in the loop, no missed bumps.
const TERMINAL_FINGERPRINT = computeTerminalFingerprint();

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, fingerprint: TERMINAL_FINGERPRINT });
});

app.get('/sessions', (_req, res) => {
  res.json(listSessions());
});

// Pre-create a pty session without a WS subscriber. The route handlers in
// the main backend call this so they can return a serverId synchronously;
// the frontend then lazy-mounts <TerminalPane> and attaches via that id.
app.post('/sessions', (req, res) => {
  const body = (req.body || {}) as {
    cwd?: string;
    cols?: number;
    rows?: number;
    initialCommand?: string;
    projectPath?: string;
  };
  const result = precreateSession({
    cwd: body.cwd,
    cols: body.cols,
    rows: body.rows,
    initialCommand: body.initialCommand,
    projectPath: body.projectPath,
  });
  if ('error' in result) return res.status(500).json(result);
  res.json({ id: result.id });
});

// Kill all sessions whose cwd is inside the given directory.
// Used before worktree deletion so Windows releases file locks.
// MUST be registered before `/sessions/:id` — Express matches routes in
// registration order, and `:id` would otherwise capture the literal
// `by-cwd` and fall into killSession with id="by-cwd" (404, silent kill skip).
app.delete('/sessions/by-cwd', (req, res) => {
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
  if (!cwd) return res.status(400).json({ error: 'cwd required' });
  const count = killSessionsByCwd(cwd);
  res.json({ ok: true, count });
});

app.delete('/sessions/:id', (req, res) => {
  const ok = killSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// JSON-only error surface. The default Express 404 / error handler returns
// HTML, which then explodes downstream when terminalProxy.ts does
// `await res.json()`. Force JSON for every unmatched route AND every
// uncaught throw inside a handler so the proxy gets a parseable body it
// can act on (and surface a clear error message back to the UI).
app.use((req, res) => {
  res.status(404).json({
    error: `terminal-server: no route for ${req.method} ${req.path}`,
  });
});
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lattice-terminal] route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: `terminal-server: ${message}` });
    }
  },
);

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const id = url.searchParams.get('id') || undefined;
  const cwd = url.searchParams.get('cwd') || undefined;
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  const initialCommand = url.searchParams.get('initialCommand') || undefined;
  const projectPath = url.searchParams.get('projectPath') || undefined;
  attachTerminal(ws, { id, cwd, cols, rows, initialCommand, projectPath });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '', 'http://localhost').pathname === '/ws/terminal') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

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
}, 60_000);
claudeConfigInterval.unref();

// Clean up PTY sessions before exiting so node-pty child processes don't
// linger as orphans (especially important on Windows where conpty helpers
// can outlive their parent if not explicitly killed).
//
// killSession fires off `taskkill /F /T` asynchronously for grandchildren
// — we have to give it a beat to actually land before process.exit, or
// the spawned taskkill commands get killed along with us and the original
// orphan problem returns.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const ids = listSessions().map((s) => s.id);
  console.log(`[lattice-terminal] shutdown: killing ${ids.length} session(s)`);
  for (const id of ids) {
    killSession(id);
  }
  // 500 ms is long enough for taskkill /T to walk a small process tree on
  // a modern Windows box; short enough that Ctrl+C still feels snappy.
  await new Promise<void>((r) => setTimeout(r, 500));
  process.exit(0);
}

// Manual shutdown trigger used by the dev orchestrator (`backend/scripts/dev.mjs`)
// when the user Ctrl+C's `npm run dev`. Detached PTYs don't naturally see
// the orchestrator's signals — without this the terminal server (and every
// PTY inside it) leaks across dev sessions.
app.post('/shutdown', (_req, res) => {
  res.json({ ok: true });
  // Run after the response so the caller doesn't hang on a dropped socket.
  setImmediate(() => { void shutdown(); });
});

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
