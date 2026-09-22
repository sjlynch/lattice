// GET /api/tasks/worktree-modified — every file changed by a not-yet-merged
// task (in_progress + ready_to_merge), for the graph's `W` highlight.
//
// Read-only against disposable worktrees (plain `exec`, never `projectGit`),
// so nothing here can touch the project repo destructively. Git path parsing,
// probing/base-branch resolution, and short-TTL result caching live in focused
// sibling modules; this file only wires the Express route.

import { Router } from 'express';
import { requireAbsoluteProject } from './requestUtils.js';
import {
  worktreeModifiedService,
  type WorktreeModifiedPayload,
} from './worktreeModifiedService.js';

export type WorktreeModifiedService = {
  load(projectPath: string): Promise<WorktreeModifiedPayload>;
};

export function buildWorktreeModifiedRouter(
  service: WorktreeModifiedService = worktreeModifiedService,
): Router {
  const r = Router();

  r.get('/api/tasks/worktree-modified', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!requireAbsoluteProject(project, res)) return;

    res.json(await service.load(project));
  });

  return r;
}
