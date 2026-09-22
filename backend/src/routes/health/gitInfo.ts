// Read-only git facts about the active project folder shown in the navbar:
// the commit timeline (`/api/git-history`, backs the timeline scrubber via
// ../../gitHistory.ts) and the current branch indicator (`/api/git-branch`).
// The branch derivation itself lives in ../../gitBranch.ts, shared with the
// `/ws/git-branch` live watcher that pushes updates on checkout.

import { Router } from 'express';
import { getGitHistory } from '../../gitHistory.js';
import { getCurrentBranch } from '../../gitBranch.js';
import { readPathParam } from '../projectParam.js';

export function buildGitInfoRouter(defaultRoot: string): Router {
  const r = Router();

  r.get('/api/git-history', async (req, res) => {
    const target = readPathParam(req, res, defaultRoot);
    if (target === null) return;
    const limit = Number(req.query.limit) || 10;
    try {
      const result = await getGitHistory(target, limit);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/git-branch', async (req, res) => {
    const target = readPathParam(req, res, defaultRoot);
    if (target === null) return;
    try {
      const branch = await getCurrentBranch(target);
      res.json({ branch });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
