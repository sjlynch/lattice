// Folder-picker backend: list a directory's contents (`/api/list-dir`) and
// create a new directory (`/api/create-dir`). Both delegate to ../../fsbrowse.ts,
// which owns the roots/validation rules.

import { Router } from 'express';
import { createDir, listDir } from '../../fsbrowse.js';

export function buildBrowseRouter(): Router {
  const r = Router();

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
