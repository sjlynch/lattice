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

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
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
  console.log(`[lattice-terminal] listening on port ${PORT}`);
});

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
