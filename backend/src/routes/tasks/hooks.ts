// Worktree lifecycle hook callbacks. Called by the in-worktree Claude's
// Stop hook (`/complete`, `/merged`, `/merge-aborted`, `/stash-resolved`).
//
// Each route's handler lives in its own focused module; this assembles them
// into the single router consumed by `routes/tasks.ts`. The resolver-finished
// branch of `/complete` and the entirety of `/merged` share the same
// "re-sync with main, finalize, requeue on conflict" flow (`finalizeResolvedTask`
// in `./finalizeResolved.ts`); the post-merge hook gating shared by
// `/complete`, `/merged`, and `/stash-resolved` lives in `./hooks/postMergeHookHelper.ts`.

import { Router } from 'express';
import { handleTaskComplete } from './hooks/complete.js';
import { handleTaskMerged } from './hooks/merged.js';
import { handleTaskMergeAborted } from './hooks/mergeAborted.js';
import { handleTaskStashResolved } from './hooks/stashResolved.js';

export function buildTaskHookRouter(backendOrigin: string): Router {
  const r = Router();
  r.post('/api/tasks/:id/complete', handleTaskComplete(backendOrigin));
  r.post('/api/tasks/:id/merged', handleTaskMerged(backendOrigin));
  r.post('/api/tasks/:id/merge-aborted', handleTaskMergeAborted(backendOrigin));
  r.post('/api/tasks/:id/stash-resolved', handleTaskStashResolved(backendOrigin));
  return r;
}
