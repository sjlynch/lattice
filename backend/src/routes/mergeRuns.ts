// Backend-driven "merge all" runs. Run state lives in mergeRuns.ts; these
// endpoints expose start / status / cancel / stash-resolved.

import { Router } from 'express';
import {
  cancelRun,
  completeRunAfterStashResolution,
  getActiveRunForProject,
  getRun,
  startMergeRun,
} from '../mergeRuns.js';

export function buildMergeRunsRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/merge-runs', async (req, res) => {
    const project =
      typeof req.body?.project === 'string' && req.body.project
        ? req.body.project
        : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      const run = await startMergeRun(project, backendOrigin);
      res.json(run);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  r.get('/api/merge-runs/active', (req, res) => {
    const project =
      typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    res.json(getActiveRunForProject(project));
  });

  r.get('/api/merge-runs/:id', (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  });

  r.post('/api/merge-runs/:id/cancel', (req, res) => {
    const ok = cancelRun(req.params.id);
    if (!ok) return res.status(404).json({ error: 'no active run with that id' });
    res.json({ ok: true });
  });

  // Claude resolved the post-run stash-pop conflict — complete the run.
  r.post('/api/merge-runs/:id/stash-resolved', (req, res) => {
    const ok = completeRunAfterStashResolution(req.params.id);
    if (!ok) return res.status(404).json({ error: 'run not found or not awaiting stash resolution' });
    res.json({ ok: true });
  });

  return r;
}
