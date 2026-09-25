// The durable terminal-tab registry's HTTP surface (backend/src/terminalRegistry/).
//
//   GET    /api/terminal-tabs?project=            the project's live tab records
//   POST   /api/terminal-tabs/restore?project=    rebuild tabs (adopt / relaunch)
//   PATCH  /api/terminal-tabs?project=            { order: id[] }
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
import { abortPostMergeHookForServerId } from '../postMergeHooks.js';
import { readProjectParam } from './projectParam.js';

// The by-id routes take the project as a scoping hint only; an absent one
// falls back to the global record lookup. A relative one is still refused
// (it would resolve under the backend's cwd — see projectParam.ts).
function optionalProject(req: Parameters<typeof readProjectParam>[0], res: Parameters<typeof readProjectParam>[1]): string | undefined | null {
  const project = readProjectParam(req, res, { optional: true });
  if (project === null) return null;
  return project || undefined;
}

export function buildTerminalTabsRouter(): Router {
  const r = Router();

  r.get('/api/terminal-tabs', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const tabs = await terminalRegistry.list(project, { includeEnded: true });
    res.json({ project: canonicalProjectPath(project), tabs });
  });

  // `?retry=1` (the sidebar's explicit "Restore tabs" click) also retries tabs
  // that ended as cwd-missing / restore-failed; the on-open pass never does.
  r.post('/api/terminal-tabs/restore', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const retryFailed = req.query.retry === '1' || req.query.retry === 'true';
    const summary = await restoreProjectTerminals(project, undefined, { retryFailed });
    res.json(summary);
  });

  // Whole-project decorations: tab order and the active tab. Order is the full
  // id list for the project's visible tabs (unlisted records keep their
  // relative order after them).
  r.patch('/api/terminal-tabs', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    const body = (req.body ?? {}) as { order?: unknown };
    if (Array.isArray(body.order)) {
      const ids = body.order.filter((x): x is string => typeof x === 'string');
      await terminalRegistry.reorder(project, ids);
    }
    res.json({ ok: true });
  });

  r.patch('/api/terminal-tabs/:id', async (req, res) => {
    const project = optionalProject(req, res);
    if (project === null) return;
    const body = (req.body ?? {}) as { label?: unknown };
    const patch: { label?: string } = {};
    if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim();
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const updated = await terminalRegistry.update(req.params.id, patch, project);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  // Close a tab: end the record first (so the exit watcher / restore never
  // resurrect it), then kill its pty if one is alive. A post-merge hook's tab is
  // a registered record too, so closing it here must end the hook `aborted`
  // before the kill, exactly as DELETE /api/terminals/:id does — otherwise the
  // hook stays `running` with a dead pty and the merge run waiting on it parks
  // for up to POST_MERGE_HOOK_MAX_WAIT_MS holding run.lock.
  r.delete('/api/terminal-tabs/:id', async (req, res) => {
    const project = optionalProject(req, res);
    if (project === null) return;
    const record = await terminalRegistry.get(req.params.id, project);
    if (!record) return res.status(404).json({ error: 'not found' });
    await terminalRegistry.end(record.id, { reason: 'closed' }, record.projectPath);
    if (record.serverId) {
      await abortPostMergeHookForServerId(record.serverId);
      const killed = await proxyKillSession(record.serverId);
      if (killed) notifySessionsFreed();
    }
    res.json({ ok: true });
  });

  return r;
}
