import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { killSession, killSessionsByCwd, listSessions, precreateSession } from '../terminal.js';
import { ensureTrustedClaudeDir } from '../claudeTrust.js';
import { isClaudeMemoryDisabled } from '../userSettings.js';
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
  // `async` so it can re-seed Claude trust before spawning — but Express 4
  // does NOT forward an async rejection to the error middleware, so the body
  // is wrapped and any throw is handed to `next` explicitly (preserving the
  // JSON-only error surface this file guarantees).
  app.post('/sessions', async (req, res, next) => {
   try {
    const body = (req.body || {}) as {
      cwd?: string;
      cols?: number;
      rows?: number;
      initialCommand?: string;
      projectPath?: string;
    };
    // Re-seed Claude's workspace-trust entry for `cwd` here, microseconds
    // before pty.spawn. The spawn sites already pre-seed at session-setup
    // time, but a queued spawn can sit in the admission queue for minutes
    // before reaching here — and during that gap any *other* Claude process
    // exiting rewrites the whole `~/.claude.json` from its own stale
    // in-memory snapshot, silently dropping the trust entry we added (Claude
    // never takes Lattice's mutex). Seeding again at this chokepoint shrinks
    // the clobber window to near zero so an agent never stalls on the "Do you
    // trust the files in this folder?" dialog. Best-effort + Claude-only:
    // `ensureTrustedClaudeDir` swallows its own errors, and pi/codex have no
    // such gate so seeding for them would just churn the config file.
    //
    // This is also the single MCP-injection chokepoint: passing `projectPath`
    // resolves the project's enabled MCP servers and reconciles them into
    // `projects[<cwd>].mcpServers` right here — microseconds before spawn, after
    // any Claude config clobber. Every backend-spawned Claude session (task
    // worktree, resolver, push, post-merge hook, workflow step, prompt
    // customization) flows through here, so one wiring point covers them all.
    const isClaudeCmd = /^\s*claude\b/.test(body.initialCommand ?? '');
    if (body.cwd && isClaudeCmd) {
      await ensureTrustedClaudeDir(body.cwd, { projectPath: body.projectPath });
    }
    // Per-project Claude auto-memory opt-out (default on). Resolved here at the
    // single Claude-spawn chokepoint and applied as an env var on the pty
    // (launchContext.ts) — it never writes the global Claude config. Best-effort:
    // a settings-read failure just leaves memory at Claude's own default.
    let disableClaudeMemory = false;
    if (isClaudeCmd && body.projectPath) {
      try {
        disableClaudeMemory = await isClaudeMemoryDisabled(body.projectPath);
      } catch {
        /* leave memory as-is */
      }
    }
    const result = precreateSession({
      cwd: body.cwd,
      cols: body.cols,
      rows: body.rows,
      initialCommand: body.initialCommand,
      projectPath: body.projectPath,
      disableClaudeMemory,
    });
    if ('error' in result) {
      // A hard-cap refusal is 503 ("at capacity") so the backend proxy can
      // distinguish it from a 500 shell-spawn failure; the `code` field is
      // the authoritative signal either way.
      return res.status(result.code === 'CAP' ? 503 : 500).json(result);
    }
    res.json({ id: result.id });
   } catch (err) {
    next(err);
   }
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
