// The durable terminal-tab registry's HTTP surface (backend/src/terminalRegistry/).
//
//   GET    /api/terminal-tabs?project=            the project's live tab records
//   POST   /api/terminal-tabs/restore?project=    rebuild tabs (adopt / relaunch)
//   PATCH  /api/terminal-tabs?project=            { order?: id[], activeId? }
//   PATCH  /api/terminal-tabs/:id?project=        { label }
//   DELETE /api/terminal-tabs/:id?project=        close: kill the pty (if any) and
//                                                 drop the record
//
// The frontend keeps only decorations here; records are CREATED by the spawn
// chokepoint. Live updates ride `/ws/terminal-tabs`.

import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import { proxyKillSession } from '../terminalServerClient.js';
import { notifySessionsFreed } from '../spawnQueue.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';

function projectFrom(req: { query: Record<string, unknown>; body?: unknown }): string | null {
  const q = req.query.project;
  if (typeof q === 'string' && q) return q;
  const b = (req.body ?? {}) as { project?: unknown };
  return typeof b.project === 'string' && b.project ? b.project : null;
}

export function buildTerminalTabsRouter(): Router {
  const r = Router();

  r.get('/api/terminal-tabs', async (req, res) => {
    const project = projectFrom(req);
    if (!project) return res.status(400).json({ error: 'project required' });
    const tabs = await terminalRegistry.list(project, { includeEnded: true });
    res.json({ project: canonicalProjectPath(project), tabs });
  });

  // `?retry=1` (the sidebar's explicit "Restore tabs" click) also retries tabs
  // that ended as cwd-missing / restore-failed; the on-open pass never does.
  r.post('/api/terminal-tabs/restore', async (req, res) => {
    const project = projectFrom(req);
    if (!project) return res.status(400).json({ error: 'project required' });
    const retryFailed = req.query.retry === '1' || req.query.retry === 'true';
    const summary = await restoreProjectTerminals(project, undefined, { retryFailed });
    res.json(summary);
  });

  // Whole-project decorations: tab order and the active tab. Order is the full
  // id list for the project's visible tabs (unlisted records keep their
  // relative order after them).
  r.patch('/api/terminal-tabs', async (req, res) => {
    const project = projectFrom(req);
    if (!project) return res.status(400).json({ error: 'project required' });
    const body = (req.body ?? {}) as { order?: unknown };
    if (Array.isArray(body.order)) {
      const ids = body.order.filter((x): x is string => typeof x === 'string');
      await terminalRegistry.reorder(project, ids);
    }
    res.json({ ok: true });
  });

  r.patch('/api/terminal-tabs/:id', async (req, res) => {
    const project = projectFrom(req) ?? undefined;
    const body = (req.body ?? {}) as { label?: unknown };
    const patch: { label?: string } = {};
    if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim();
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const updated = await terminalRegistry.update(req.params.id, patch, project);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  // Close a tab: end the record first (so the exit watcher / restore never
  // resurrect it), then kill its pty if one is alive.
  r.delete('/api/terminal-tabs/:id', async (req, res) => {
    const project = projectFrom(req) ?? undefined;
    const record = await terminalRegistry.get(req.params.id, project);
    if (!record) return res.status(404).json({ error: 'not found' });
    await terminalRegistry.end(record.id, { reason: 'closed' }, record.projectPath);
    if (record.serverId) {
      const killed = await proxyKillSession(record.serverId);
      if (killed) notifySessionsFreed();
    }
    res.json({ ok: true });
  });

  return r;
}
