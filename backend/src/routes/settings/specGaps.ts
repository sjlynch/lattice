import { Router } from 'express';
import { listTasks } from '../../tasks.js';
import { recentSpecGaps } from '../../specGaps.js';
import { readProjectParam } from '../projectParam.js';

export function buildSpecGapsRouter(): Router {
  const r = Router();
  r.get('/api/spec-gaps', async (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const raw = req.query.limit;
    const limit = raw === undefined ? 25 : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
    }
    res.json({ gaps: recentSpecGaps(await listTasks(project), { limit }) });
  });
  return r;
}
