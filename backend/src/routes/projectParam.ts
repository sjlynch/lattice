// The one way a route reads the `project` it acts on.
//
// Every per-project store resolves its path through `canonicalProjectPath`,
// which is `path.resolve()` underneath — so a RELATIVE or drive-relative value
// (`foo`; `C:developmentproj` after a shell ate the backslashes) silently
// resolves under the BACKEND's own cwd. `PATCH /api/settings?project=foo` used
// to create `backend/foo/.lattice/userSettings.json`; a workflow, terminal-tab,
// merge-run or instrumentation request did the same for its store, and the
// phantom project could even end up indexed in `~/.lattice/projects.json`. The
// task routes have refused this for a while (`requireAbsoluteProject`,
// `validateProjectForCreate`); this extends the same rule to every other
// project-scoped route.
//
// Reads `?project=` first, then the body (the tasks convention: the URL is the
// easy place for a shell agent to put it). Returns the trimmed raw project —
// callers canonicalize as they always did — or `null` once it has sent the
// 400. With `optional: true` an absent project yields `''` (routes where the
// project only narrows a machine-wide answer); a present-but-relative one is
// still refused.

import path from 'node:path';
import type { Response } from 'express';

type ProjectSource = 'query' | 'body' | 'both';

export function readProjectParam(
  req: { query?: unknown; body?: unknown },
  res: Response,
  opts: { source?: ProjectSource; optional?: boolean } = {},
): string | null {
  const source = opts.source ?? 'both';
  let raw = '';
  if (source !== 'body') {
    const q = req.query as Record<string, unknown> | undefined;
    if (typeof q?.project === 'string') raw = q.project.trim();
  }
  if (!raw && source !== 'query') {
    const b = req.body as Record<string, unknown> | undefined;
    if (b && typeof b === 'object' && typeof b.project === 'string') raw = b.project.trim();
  }
  if (!raw) {
    if (opts.optional) return '';
    res.status(400).json({ error: 'project required' });
    return null;
  }
  if (!path.isAbsolute(raw)) {
    res.status(400).json({ error: relativeProjectError(raw) });
    return null;
  }
  return raw;
}

export function relativeProjectError(raw: string): string {
  return (
    `project must be an absolute path, got ${JSON.stringify(raw)}. ` +
    `A relative or drive-relative path almost always means backslashes were ` +
    `stripped by shell escaping (e.g. C:\\development\\proj arriving as ` +
    `"C:developmentproj"). Pass the full absolute path.`
  );
}
