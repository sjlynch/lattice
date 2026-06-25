// Read-only git facts about the active project folder shown in the navbar:
// the commit timeline (`/api/git-history`, backs the timeline scrubber via
// ../../gitHistory.ts) and the current branch indicator (`/api/git-branch`).

import { Router } from 'express';
import { getGitHistory } from '../../gitHistory.js';
import { exec } from '../../worktree/exec.js';

const GIT_BRANCH_TIMEOUT_MS = 4000;

// Current branch of a repo's working tree (the active project folder shown in
// the navbar). `rev-parse --abbrev-ref HEAD` yields the branch name, or the
// literal "HEAD" when detached — in which case we surface the short sha so the
// navbar shows something meaningful instead of a bare "HEAD". Returns null when
// the folder isn't a git repo (or git isn't available), so the navbar can just
// omit the branch indicator.
async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const name = r.stdout.trim();
    if (r.code !== 0 || !name) return null;
    if (name !== 'HEAD') return name;
    const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], repoRoot, {
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
    });
    const short = sha.stdout.trim();
    return short ? `detached @ ${short}` : null;
  } catch {
    return null;
  }
}

export function buildGitInfoRouter(defaultRoot: string): Router {
  const r = Router();

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

  r.get('/api/git-branch', async (req, res) => {
    const target =
      typeof req.query.path === 'string' ? req.query.path : defaultRoot;
    try {
      const branch = await getCurrentBranch(target);
      res.json({ branch });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return r;
}
