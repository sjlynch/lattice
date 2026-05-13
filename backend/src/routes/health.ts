// Health checks, default-root probe, file-system scan, and folder browser.

import { Router } from 'express';
import { scan } from '../scanner.js';
import { createDir, listDir } from '../fsbrowse.js';
import { detectHarnesses, resetHarnessCache } from '../harnessDetect.js';
import { getGitHistory } from '../gitHistory.js';

export function buildHealthRouter(defaultRoot: string): Router {
  const r = Router();

  r.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  r.get('/api/harnesses', async (req, res) => {
    if (req.query.refresh === '1') resetHarnessCache();
    res.json(await detectHarnesses());
  });

  r.get('/api/default-root', (_req, res) => {
    res.json({ path: defaultRoot });
  });

  r.get('/api/scan', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    try {
      const result = await scan(target);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/git-history', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    const limit = Number(req.query.limit) || 10;
    try {
      const result = await getGitHistory(target, limit);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/api/list-dir', async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : undefined;
    try {
      const result = await listDir(target);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.post('/api/create-dir', async (req, res) => {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '';
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    try {
      const result = await createDir(parent, name);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
