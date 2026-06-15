// File-contents search backing the graph search bar. Filename matching is
// done client-side off the loaded graph; this endpoint is the contents pass.

import { Router } from 'express';
import { searchProjectContents } from '../search.js';

export function buildSearchRouter(defaultRoot: string): Router {
  const r = Router();

  // GET /api/search?project=&q=&regex=0|1&limit=
  //   → { matches: string[]  // absolute paths == graph file-node ids
  //     , scanned: number, truncated: boolean }
  r.get('/api/search', async (req, res) => {
    const target =
      typeof req.query.project === 'string'
        ? req.query.project
        : typeof req.query.path === 'string'
          ? req.query.path
          : defaultRoot;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const regex = req.query.regex === '1' || req.query.regex === 'true';
    const limit = Number(req.query.limit) || undefined;

    // No query → nothing to do; don't walk the tree.
    if (!q) {
      res.json({ matches: [], scanned: 0, truncated: false });
      return;
    }

    // The browser aborts a superseded debounced request; stop reading files
    // once it does (mirrors /api/scan's client-gone handling).
    let clientGone = false;
    req.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    try {
      const result = await searchProjectContents(target, {
        pattern: q,
        regex,
        limit,
        isCancelled: () => clientGone,
      });
      if (clientGone) return;
      res.json(result);
    } catch (err) {
      if (clientGone) return;
      // Most likely an invalid user-supplied regex.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
