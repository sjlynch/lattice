import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { killSession, killSessionsByCwd, listSessions, precreateSession } from '../terminal.js';
import type { TerminalShutdown } from './shutdown.js';

export function registerTerminalRoutes(
  app: Express,
  { fingerprint, shutdown }: { fingerprint: string; shutdown: TerminalShutdown },
): void {
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, fingerprint });
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

  // Manual shutdown trigger used by the dev orchestrator (`backend/scripts/dev.mjs`)
  // when the user Ctrl+C's `npm run dev`. Detached PTYs don't naturally see
  // the orchestrator's signals — without this the terminal server (and every
  // PTY inside it) leaks across dev sessions.
  app.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    // Run after the response so the caller doesn't hang on a dropped socket.
    setImmediate(() => { void shutdown(); });
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
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[lattice-terminal] route error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: `terminal-server: ${message}` });
      }
    },
  );
}
