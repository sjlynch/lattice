// Debug + lifecycle endpoints for PTY sessions owned by the terminal-server
// subprocess. Sessions are listed and killed via the proxy because the
// terminal server is detached and lives in a separate process.

import { Router } from 'express';
import {
  proxyCreateSession,
  proxyKillSession,
  proxyListSessions,
} from '../terminalProxy.js';
import { getSpawnQueueSnapshot } from '../spawnQueue.js';

export function buildTerminalsRouter(): Router {
  const r = Router();

  r.get('/api/terminals', async (_req, res) => {
    res.json(await proxyListSessions());
  });

  // Pre-create a pty session for a sidebar-launched terminal and return its
  // serverId, so the frontend attaches to the ALREADY-configured pty by id
  // instead of connecting serverlessly to `/ws/terminal` (which spawns the pty
  // straight from the WS query params, bypassing the spawn chokepoint).
  //
  // This is the ONE place the manual "new terminal" launcher joins the same
  // `proxyCreateSession → resolveHarnessSpawnBody` path that task / workflow /
  // push / QA spawns already use — so a sidebar Codex/Pi terminal actually gets
  // its MCP config applied (Codex `-c` overrides, Pi `<cwd>/.pi/mcp.json`).
  // Before this, only Claude sidebar terminals saw MCP, and only because their
  // config is ALSO persisted into `~/.claude.json` on project open; Codex and Pi
  // have no such persistent path, so a serverless launch left them with nothing.
  // Uses `proxyCreateSession` directly (not the spawn queue): a manual terminal
  // is a single deliberate action that should open immediately; the terminal
  // server's own hard session cap is the runaway backstop.
  r.post('/api/terminals', async (req, res) => {
    const body = (req.body ?? {}) as {
      cwd?: string;
      initialCommand?: string;
      projectPath?: string;
      cols?: number;
      rows?: number;
    };
    const result = await proxyCreateSession({
      cwd: body.cwd,
      initialCommand: body.initialCommand,
      projectPath: body.projectPath,
      cols: body.cols,
      rows: body.rows,
    });
    if ('error' in result) {
      // 503 for the hard-cap refusal (matches the terminal-server's CAP code)
      // so the frontend can distinguish "at capacity" from a real spawn error.
      return res.status(result.code === 'CAP' ? 503 : 500).json(result);
    }
    res.json({ id: result.id });
  });

  r.delete('/api/terminals/:id', async (req, res) => {
    const ok = await proxyKillSession(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // Debug: spawn-queue state — pending/in-flight items, reserved slots, the
  // last polled session count, effective concurrency, and the softCap.
  r.get('/api/spawn-queue', (_req, res) => {
    res.json(getSpawnQueueSnapshot());
  });

  return r;
}
