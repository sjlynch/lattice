// Post-merge hook lifecycle routes. The hook itself is fired by the merge
// finalizers (mergeRuns.ts / worktree/finalize.ts); these endpoints expose:
//
//   GET    /api/post-merge-hooks/active?project=
//          The active or most-recent hook for a project (UI rehydration).
//   POST   /api/post-merge-hooks/:id/complete
//          Stop-hook callback. Idempotent. Optional ?error= surfaces a failure
//          state to the UI without leaving the merge run blocked.
//   POST   /api/post-merge-hooks/:id/abort
//          User clicked "Abort" in the UI. Same effect as /complete with an
//          error, plus tries to tear down the pty by serverId.

import { Router } from 'express';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  getMostRecentHookForProject,
  getPostMergeHook,
} from '../postMergeHooks.js';
import { canonicalProjectPath } from '../projectPath.js';
import { proxyKillSession } from '../terminalProxy.js';
import { postMergeHookAgentId } from '../postMergeHooks/stopHook.js';
import { unregisterAgentSession } from '../agentSessions.js';

export function buildPostMergeHooksRouter(): Router {
  const r = Router();

  r.get('/api/post-merge-hooks/active', (req, res) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const key = canonicalProjectPath(project);
    const active = getActiveHookForProject(key);
    if (active) return res.json({ active, recent: null });
    const recent = getMostRecentHookForProject(key);
    res.json({ active: null, recent });
  });

  r.post('/api/post-merge-hooks/:id/complete', (req, res) => {
    const id = req.params.id;
    const source =
      typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const errParam =
      typeof req.query.error === 'string' && req.query.error.trim()
        ? req.query.error.trim().slice(0, 500)
        : undefined;
    const existing = getPostMergeHook(id);
    // Drop the graph node regardless of tracking state.
    unregisterAgentSession(postMergeHookAgentId(id));
    console.log(
      `[post-merge-hook-complete] id=${id} source=${source}` +
        (errParam ? ` error=${JSON.stringify(errParam)}` : '') +
        (existing ? '' : ' (idempotent: already finished/forgotten)'),
    );
    if (!existing) {
      // Idempotent — a duplicate POST after the hook has been forgotten is a
      // no-op. The harness may have curled twice (explicit + Stop hook).
      return res.json({ ok: true });
    }
    finishPostMergeHook(id, errParam ? 'errored' : 'completed', errParam);
    res.json({ ok: true });
  });

  r.post('/api/post-merge-hooks/:id/abort', async (req, res) => {
    const id = req.params.id;
    unregisterAgentSession(postMergeHookAgentId(id));
    const existing = getPostMergeHook(id);
    if (!existing) return res.json({ ok: true });
    // Best-effort kill the pty so the user gets immediate feedback.
    if (existing.serverId) {
      try {
        await proxyKillSession(existing.serverId);
      } catch {
        /* ignore */
      }
    }
    finishPostMergeHook(id, 'aborted', 'aborted by user');
    res.json({ ok: true });
  });

  return r;
}
