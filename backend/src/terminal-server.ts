// Standalone terminal server. Runs as a detached child process owned
// separately from the main Lattice server so PTY sessions (and the Claude
// agents inside them) survive main server restarts.
//
// Spawned by the main server on startup via terminalProxy.ts.
// Binds to 127.0.0.1 only — not accessible from outside localhost.

import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { attachTerminal, killSession, killSessionsByCwd, listSessions } from './terminal.js';

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

app.delete('/sessions/:id', (req, res) => {
  const ok = killSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Kill all sessions whose cwd is inside the given directory.
// Used before worktree deletion so Windows releases file locks.
app.delete('/sessions/by-cwd', (req, res) => {
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
  if (!cwd) return res.status(400).json({ error: 'cwd required' });
  const count = killSessionsByCwd(cwd);
  res.json({ ok: true, count });
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
function shutdown() {
  for (const { id } of listSessions()) {
    killSession(id);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
