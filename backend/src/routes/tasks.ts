// Composes the per-concern task routers into the single export consumed
// by the rest of the backend. Each sub-router lives in `routes/tasks/`:
//
//   - crud.ts   : list / summary / get / create / batch / transition /
//                 patch / reorder / delete
//   - run.ts    : run / resume / merge (worktree spawning + orchestration)
//   - hooks.ts  : complete / merged / merge-aborted / stash-resolved
//                 (worktree Stop-hook callbacks)
//
// `/api/tasks/summary` MUST stay registered before `/api/tasks/:id` to
// avoid `summary` being captured as an :id — both live in crud.ts which
// preserves that internal ordering.

import { Router } from 'express';
import { buildTaskCrudRouter } from './tasks/crud.js';
import { buildTaskRunRouter } from './tasks/run.js';
import { buildTaskHookRouter } from './tasks/hooks.js';

// Re-exported for backend/src/__tests__/tasksApi.test.ts which imports it
// from this module path.
export { parseMarkdownTasks } from './tasks/crud.js';

export function buildTasksRouter(backendOrigin: string): Router {
  const r = Router();
  r.use(buildTaskCrudRouter());
  r.use(buildTaskRunRouter(backendOrigin));
  r.use(buildTaskHookRouter(backendOrigin));
  return r;
}
