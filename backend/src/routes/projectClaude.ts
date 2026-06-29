// Project-level Claude instrumentation: make ANY Claude session working in an
// opened project show up on the graph, not just the ones Lattice spawns.
//
//   POST /api/project-instrumentation { project }
//     Idempotently install (or, when the per-project setting is off, remove)
//     Lattice's activity hooks in <project>/.claude/settings.local.json.
//     Called by the frontend when a project is opened / the toggle changes.
//   POST /api/project-activity/:token
//     PreToolUse/PostToolUse/SessionStart/SessionEnd hook callback for those
//     sessions. Keyed by Claude's session_id (from the body), it drives the
//     same orange node + focus beams as the Lattice-spawned non-worktree
//     sessions (reuses agentSessions + agentActivity).

import { Router } from 'express';
import { applyProjectActivityHook } from '../projectClaude/activity.js';
import { reconcileProjectInstrumentation } from '../projectClaude/reconcile.js';

export { applyProjectActivityEvent } from '../projectClaude/lifecycle.js';

export function buildProjectClaudeRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/project-instrumentation', async (req, res) => {
    const project =
      typeof req.body?.project === 'string' ? req.body.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      const result = await reconcileProjectInstrumentation(project, backendOrigin);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.warn('[project-instrumentation] failed:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  r.post('/api/project-activity/:token', (req, res) => {
    // Always 204 — the session's curl ignores the body, and a hook must never
    // surface an error into the agent's tool call.
    applyProjectActivityHook(req.params.token, req.body);
    return res.status(204).end();
  });

  return r;
}
