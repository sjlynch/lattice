import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { killSession, killSessionsByCwd, listSessions } from '../terminal.js';
import { tokenMatches, TERMINAL_SERVER_AUTH_HEADER } from '../terminalServerAuth.js';
import { isAllowedOrigin } from '../wsOriginAllowlist.js';
import { createSessionHandler } from './createSessionHandler.js';
import type { TerminalShutdown } from './shutdown.js';

export type RegisterTerminalRoutesOptions = {
  fingerprint: string;
  shutdown: TerminalShutdown;
  authToken: string;
  // Test seam: lets route/security tests verify auth gating without spawning a
  // real pty. Production uses createSessionHandler(), which preserves the CAP
  // response shaping and Claude config injection behavior.
  sessionHandler?: RequestHandler;
};

function requireTerminalAuth(authToken: string): RequestHandler {
  return (req, res, next) => {
    // Browser requests carry an immutable Origin. Reject disallowed origins
    // before token validation so the detached HTTP API follows the same allowlist
    // as the terminal WebSocket upgrade path. Absent-Origin backend/curl requests
    // remain allowed, then must present the shared token below.
    if (!isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'terminal-server: origin not allowed' });
      return;
    }

    const header = req.get(TERMINAL_SERVER_AUTH_HEADER);
    if (!tokenMatches(authToken, header)) {
      res.status(401).json({ error: 'terminal-server: unauthorized' });
      return;
    }
    next();
  };
}

export function registerTerminalRoutes(
  app: Express,
  { fingerprint, shutdown, authToken, sessionHandler }: RegisterTerminalRoutesOptions,
): void {
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, fingerprint });
  });

  const requireAuth = requireTerminalAuth(authToken);

  app.get('/sessions', requireAuth, (_req, res) => {
    res.json(listSessions());
  });

  app.post('/sessions', requireAuth, sessionHandler ?? createSessionHandler());

  // Kill all sessions whose cwd is inside the given directory.
  // Used before worktree deletion so Windows releases file locks.
  // MUST be registered before `/sessions/:id` — Express matches routes in
  // registration order, and `:id` would otherwise capture the literal
  // `by-cwd` and fall into killSession with id="by-cwd" (404, silent kill skip).
  app.delete('/sessions/by-cwd', requireAuth, (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    const count = killSessionsByCwd(cwd);
    res.json({ ok: true, count });
  });

  app.delete('/sessions/:id', requireAuth, (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const ok = id ? killSession(id) : false;
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Manual shutdown trigger used by the dev orchestrator (`backend/scripts/dev.mjs`)
  // when the user Ctrl+C's `npm run dev`. Detached PTYs don't naturally see
  // the orchestrator's signals — without this the terminal server (and every
  // PTY inside it) leaks across dev sessions.
  app.post('/shutdown', requireAuth, (_req, res) => {
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
