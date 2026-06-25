// GET /api/tasks/worktree-modified — every file changed by a not-yet-merged
// task (in_progress + ready_to_merge), for the graph's `W` highlight.
//
// Read-only against the disposable worktree (plain `exec`, never `projectGit`),
// so nothing here can touch the project repo destructively. The git diff/status
// polling, base-branch resolution + caching, and the short-TTL result cache all
// live here; the `POST /api/tasks/:id/activity` hook decoding stays in
// `activity.ts` (which also owns the shared `isManaged` filter, imported below).

import path from 'node:path';
import { Router } from 'express';
import { listTasks, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { exec } from '../../worktree/exec.js';
import { isManaged } from './activity.js';

const GIT_TIMEOUT_MS = 5000;

// Parse `git status --porcelain` output into repo-relative paths. Handles
// renames ("R  old -> new" → the new path).
function parsePorcelainPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    // Porcelain quotes paths with unusual chars; strip the wrapping quotes.
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p) paths.push(p);
  }
  return paths;
}

// Files this task has changed relative to the base branch: committed work
// (`<base>...HEAD`, three-dot = since the merge-base) plus the live
// uncommitted working tree. Read-only; returns project-absolute paths.
async function modifiedFilesForTask(
  task: Task,
  baseBranch: string,
): Promise<string[]> {
  if (!task.worktreePath) return [];
  const rels = new Set<string>();
  try {
    const committed = await exec(
      'git',
      ['diff', '--name-only', `${baseBranch}...HEAD`],
      task.worktreePath,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (committed.code === 0) {
      for (const r of committed.stdout.split(/\r?\n/)) {
        const p = r.trim();
        if (p) rels.add(p);
      }
    }
  } catch {
    /* worktree gone / git error — fall through to status */
  }
  try {
    const status = await exec('git', ['status', '--porcelain'], task.worktreePath, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (status.code === 0) {
      for (const p of parsePorcelainPaths(status.stdout)) rels.add(p);
    }
  } catch {
    /* ignore */
  }
  const root = canonicalProjectPath(task.projectPath);
  const out: string[] = [];
  for (const rel of rels) {
    if (isManaged(rel)) continue;
    out.push(path.join(root, rel));
  }
  return out;
}

// The project's base branch (what tasks were forked from). `rev-parse
// --abbrev-ref HEAD` in the main repo = "main" / "master" / whatever.
// Returns null on failure so the cached wrapper can fall back without
// poisoning the cache with a spurious "main".
async function resolveBaseBranch(projectPath: string): Promise<string | null> {
  try {
    const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectPath, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const name = r.stdout.trim();
    if (r.code === 0 && name && name !== 'HEAD') return name;
  } catch {
    /* fall through */
  }
  return null;
}

// The base branch does not change mid-session, so cache the resolved name
// per project (keyed by canonical path) and skip the `git rev-parse` spawn on
// every poll. A failed resolution falls back to "main" for that request only,
// without caching it.
const baseBranchCache = new Map<string, string>();

async function resolveBaseBranchCached(projectPath: string): Promise<string> {
  const key = canonicalProjectPath(projectPath);
  const cached = baseBranchCache.get(key);
  if (cached) return cached;
  const resolved = await resolveBaseBranch(projectPath);
  if (resolved) {
    baseBranchCache.set(key, resolved);
    return resolved;
  }
  return 'main';
}

// Short-TTL cache of the computed `/worktree-modified` payload, keyed by
// canonical project path. The graph's `W` highlight polls this endpoint
// repeatedly; within the TTL a burst of polls reuses the last result instead
// of re-spawning `git diff` + `git status` per active task. Entries simply
// expire — no invalidation needed; staleness is bounded by the TTL.
const RESULT_TTL_MS = 1500;

type WorktreeModifiedPayload = {
  tasks: Array<{ taskId: string; colorIndex: Task['colorIndex']; files: string[] }>;
};

const resultCache = new Map<string, { expires: number; payload: WorktreeModifiedPayload }>();

export function buildWorktreeModifiedRouter(): Router {
  const r = Router();

  r.get('/api/tasks/worktree-modified', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });

    const cacheKey = canonicalProjectPath(project);
    const now = Date.now();
    const cached = resultCache.get(cacheKey);
    if (cached && cached.expires > now) return res.json(cached.payload);

    const tasks = await listTasks(project);
    const active = tasks.filter(
      (t) =>
        (t.status === 'in_progress' || t.status === 'ready_to_merge') &&
        t.worktreePath,
    );

    let payload: WorktreeModifiedPayload;
    if (active.length === 0) {
      payload = { tasks: [] };
    } else {
      const baseBranch = await resolveBaseBranchCached(project);
      const results = await Promise.all(
        active.map(async (t) => ({
          taskId: t.id,
          colorIndex: t.colorIndex,
          files: await modifiedFilesForTask(t, baseBranch),
        })),
      );
      payload = { tasks: results.filter((t) => t.files.length > 0) };
    }

    resultCache.set(cacheKey, { expires: now + RESULT_TTL_MS, payload });
    res.json(payload);
  });

  return r;
}
