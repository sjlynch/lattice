// File-contents search backing the graph search bar. Filename matching is
// done client-side off the loaded graph; this endpoint is the contents pass.

import { Router } from 'express';
import { searchProjectContents } from '../search.js';
import { readPathParam } from './projectParam.js';

// Coerce the user-supplied `limit` query param to a positive integer, else
// undefined (search.ts then applies its default). A fractional/garbage value
// (e.g. `?limit=1.5`) must not slip through: handed on as a non-integer cap it
// makes ripgrep error — forcing the slow JS fallback on every keystroke — and
// gives the rg path (`slice(0, 1.5)` → 1) and the JS path (`matches.length >=
// 1.5` → 2) inconsistent cutoffs. Floor first, then accept only finite > 0.
export function parseLimitParam(raw: unknown): number | undefined {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildSearchRouter(
  defaultRoot: string,
  search: typeof searchProjectContents = searchProjectContents,
): Router {
  const r = Router();

  // GET /api/search?project=&q=&regex=0|1&limit=
  //   → { matches: string[]  // absolute paths == graph file-node ids
  //     , scanned: number, truncated: boolean }
  r.get('/api/search', async (req, res) => {
    const target = readPathParam(req, res, defaultRoot);
    if (target === null) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const regex = req.query.regex === '1' || req.query.regex === 'true';
    const limit = parseLimitParam(req.query.limit);

    // No query → nothing to do; don't walk the tree.
    if (!q) {
      res.json({ matches: [], scanned: 0, truncated: false });
      return;
    }

    // The browser aborts a superseded debounced request; stop reading files
    // once it does (mirrors /api/scan's client-gone handling). Observe the
    // RESPONSE's close, not the request's: IncomingMessage `close` also fires
    // for a fully consumed GET while its response is still pending, which
    // would have cancelled every search that outlived its own body.
    let clientGone = false;
    const onClose = () => {
      if (!res.writableEnded) clientGone = true;
    };
    res.on('close', onClose);

    try {
      const result = await search(target, {
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
    } finally {
      res.off('close', onClose);
    }
  });

  return r;
}
