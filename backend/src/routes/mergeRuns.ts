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
import { getActiveHookForProject } from '../postMergeHooks.js';
import { canonicalProjectPath } from '../projectPath.js';
import { readRecoveryAttempts } from '../recovery/retryBudget.js';
import { readProjectParam } from './projectParam.js';

export function buildMergeRunsRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/merge-runs', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    if (getActiveHookForProject(canonicalProjectPath(project))) {
      return res.status(409).json({
        error: 'A post-merge hook is still running for this project — wait for it to finish (or abort it).',
      });
    }
    try {
      const run = await startMergeRun(project, backendOrigin, { resetRecoveryBudget: true });
      res.json(run);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  r.get('/api/merge-runs/active', (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json(getActiveRunForProject(project));
  });

  r.get('/api/merge-runs/recovery', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    res.json({ attempts: await readRecoveryAttempts(project) });
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
