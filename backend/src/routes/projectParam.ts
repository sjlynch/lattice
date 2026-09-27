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

import fs from 'node:fs/promises';
import type { Response } from 'express';
import {
  canonicalProjectPath,
  isRealAbsoluteProjectPath,
  msysToWindowsPath,
} from '../projectPath.js';

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
  if (!isRealAbsoluteProjectPath(raw)) {
    res.status(400).json({ error: relativeProjectError(raw) });
    return null;
  }
  return raw;
}

// For a route that WRITES under the project folder (`<project>/.lattice/…`):
// the per-project stores `mkdir -p` their directory, so a typo'd project — or a
// UI tab still open on a project whose folder was deleted — would otherwise
// resurrect the folder on its next save. Returns true when the canonical
// project path is an existing directory; false once it has sent the 400.
export async function requireExistingProjectDir(
  project: string,
  res: Response,
): Promise<boolean> {
  const root = canonicalProjectPath(project);
  const isDir = await fs.stat(root).then((st) => st.isDirectory(), () => false);
  if (isDir) return true;
  res.status(400).json({ error: `project is not an existing directory: ${JSON.stringify(root)}` });
  return false;
}

// The `?project=` / `?path=` convention of the read-only graph routes
// (`/api/scan`, `/api/search`, `/api/health/dead-code`, `/api/git-history`,
// `/api/git-branch`): an ABSENT value falls back to the backend's default root
// (kept — the UI relies on it), while a present-but-relative one is refused
// with the same 400 as everywhere else. Returns the folder to act on, or
// `null` once it has sent the 400.
export function readPathParam(
  req: { query?: unknown },
  res: Response,
  defaultRoot: string,
): string | null {
  const q = req.query as Record<string, unknown> | undefined;
  const raw =
    typeof q?.project === 'string'
      ? q.project.trim()
      : typeof q?.path === 'string'
        ? q.path.trim()
        : '';
  if (!raw) return defaultRoot;
  if (!isRealAbsoluteProjectPath(raw)) {
    res.status(400).json({ error: relativeProjectError(raw) });
    return null;
  }
  return raw;
}

// Optional `?project=` pin for a by-id route whose record is looked up
// GLOBALLY (a workflow definition id, a workflow run id). Mirrors
// `requireTaskInRequestedProject` (routes/tasks/requestUtils.ts): when the
// caller sends a non-empty `?project=`, the record must belong to it
// (canonical-path compare) or the request is a 404 with a "wrong board" hint;
// with no project sent — Stop-hook callbacks, agents' curls, the UI — it
// proceeds exactly as before. Returns true when the request may proceed;
// false once it has sent the 404.
export function requireOwnedByRequestedProject(
  ownerProjectPath: string,
  what: string,
  req: { query?: unknown },
  res: Response,
): boolean {
  const q = req.query as Record<string, unknown> | undefined;
  const project = typeof q?.project === 'string' ? q.project.trim() : '';
  if (!project) return true;
  if (canonicalProjectPath(ownerProjectPath) === canonicalProjectPath(project)) return true;
  res.status(404).json({
    error: 'not found',
    hint:
      `${what} is not in project ${canonicalProjectPath(project)} — it belongs ` +
      'to a different board. Check the project this session is pinned to before retrying.',
  });
  return false;
}

export function relativeProjectError(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Windows root-relative (`\foo`, MSYS `/c/development/proj`): path.isAbsolute
  // accepts it, but path.resolve pins it to the backend's drive
  // (`C:\c\development\proj`) — a phantom project with an empty board.
  if (platform === 'win32' && /^[\\/](?![\\/])/.test(raw)) {
    const suggestion = msysToWindowsPath(raw);
    return (
      `project must be an absolute path, got ${JSON.stringify(raw)}. ` +
      `On Windows a path starting with a single slash is root-relative, not ` +
      `absolute — it would resolve onto the backend's current drive. ` +
      (suggestion
        ? `This looks like an MSYS / Git-Bash path: pass ${JSON.stringify(suggestion)} instead. `
        : '') +
      `Pass a drive-absolute (C:\\...) or UNC (\\\\server\\share\\...) path, and ` +
      `watch for backslashes stripped by shell escaping.`
    );
  }
  return (
    `project must be an absolute path, got ${JSON.stringify(raw)}. ` +
    `A relative or drive-relative path almost always means backslashes were ` +
    `stripped by shell escaping (e.g. C:\\development\\proj arriving as ` +
    `"C:developmentproj"). Pass the full absolute path.`
  );
}
