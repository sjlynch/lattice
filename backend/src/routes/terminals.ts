// Debug + lifecycle endpoints for PTY sessions owned by the terminal-server
// subprocess. Sessions are listed and killed via the proxy because the
// terminal server is detached and lives in a separate process.

import path from 'node:path';
import { Router } from 'express';
import { relativeProjectError } from './projectParam.js';
import { proxyCreateSession, proxyListSessions } from '../terminalProxy.js';
// The RAW kill (no registry bookkeeping): this route ends the record itself,
// with the `closed` reason a user-closed tab needs — see the DELETE handler.
import { proxyKillSession as rawProxyKillSession } from '../terminalServerClient.js';
import { getSpawnQueueSnapshot } from '../spawnQueue.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { endPostMergeHook, getActiveHookForServerId } from '../postMergeHooks.js';

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
      // Registry decorations for the durable tab record (see
      // terminalRegistry/). Only `user` / `startup` owners are accepted from
      // the browser; every other owner is reserved for backend spawn sites.
      label?: string;
      owner?: string;
      startupId?: string;
      piModel?: string;
    };
    const owner = body.owner === 'startup' ? 'startup' : 'user';
    // Shape checks: a non-string cwd/command would otherwise reach the pty
    // spawn (and the registry record) as garbage; a relative cwd would spawn
    // the shell under the backend's own cwd and register a tab for it.
    for (const [key, value] of [['cwd', body.cwd], ['initialCommand', body.initialCommand], ['projectPath', body.projectPath]] as const) {
      if (value !== undefined && typeof value !== 'string') {
        return res.status(400).json({ error: `${key} must be a string` });
      }
    }
    if (typeof body.cwd === 'string' && body.cwd.trim() && !path.isAbsolute(body.cwd.trim())) {
      return res.status(400).json({ error: relativeProjectError(body.cwd.trim()).replace('project must', 'cwd must') });
    }
    // Positive integer within ConPTY's 16-bit limit — mirrors `isPtyDimension`.
    const cols = Number.isInteger(body.cols) && (body.cols as number) > 0 && (body.cols as number) <= 32767 ? body.cols : undefined;
    const rows = Number.isInteger(body.rows) && (body.rows as number) > 0 && (body.rows as number) <= 32767 ? body.rows : undefined;
    const result = await proxyCreateSession({
      cwd: body.cwd,
      initialCommand: body.initialCommand,
      projectPath: body.projectPath,
      cols,
      rows,
      registry: {
        owner,
        ...(typeof body.label === 'string' && body.label.trim() ? { label: body.label.trim() } : {}),
        ...(owner === 'startup' ? { kind: 'startup' as const } : {}),
        ...(typeof body.startupId === 'string' && body.startupId ? { startupId: body.startupId } : {}),
        ...(typeof body.piModel === 'string' && body.piModel ? { piModel: body.piModel } : {}),
      },
    });
    if ('error' in result) {
      // 503 for the hard-cap refusal (matches the terminal-server's CAP code)
      // so the frontend can distinguish "at capacity" from a real spawn error.
      return res.status(result.code === 'CAP' ? 503 : 500).json(result);
    }
    res.json({ id: result.id, terminalId: result.terminalId, agentSession: result.agentSession });
  });

  // Kill a pty by session id. Also ends its registry record as user-closed
  // (a tab closed from the sidebar must never be relaunched by restore) — once,
  // here, with the raw kill underneath: the `terminalProxy` wrapper would end
  // the same record a second time as `killed`.
  //
  // If the pty belongs to a running post-merge hook, closing its tab is the
  // user giving up on it: end the hook `aborted` so the merge run / workflow
  // Merge step waiting on its callback unblocks instead of parking until the
  // wait's deadline. The hook's own kill is skipped — it happens right below.
  r.delete('/api/terminals/:id', async (req, res) => {
    const hook = getActiveHookForServerId(req.params.id);
    if (hook) {
      await endPostMergeHook(hook.id, 'aborted', 'terminal closed by user', {
        killSession: false,
      });
    }
    await terminalRegistry
      .endWhere((r) => r.serverId === req.params.id, { reason: 'closed' })
      .catch(() => 0);
    const ok = await rawProxyKillSession(req.params.id);
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
