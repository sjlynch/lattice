// Plain CRUD / list / batch / transition / reorder routes for tasks.
// No worktree spawning, no merge orchestration — just data manipulation.

import { Router, text as textBodyParser } from 'express';
import {
  handleTaskAppendSummary,
  handleTaskBatchCreate,
  handleTaskCreate,
  handleTaskDelete,
  handleTaskGet,
  handleTaskList,
  handleTaskReorder,
  handleTaskSummary,
  handleTaskTransition,
  handleTaskUpdate,
} from './crudHandlers.js';

export function buildTaskCrudRouter(): Router {
  const r = Router();

  r.get('/api/tasks', handleTaskList);

  // Counts by status — saves agents from writing a "load-then-tally" script
  // when they just want to know what's on the board.
  // MUST be registered before `/api/tasks/:id`, which would otherwise
  // capture `summary` as an :id and 404.
  r.get('/api/tasks/summary', handleTaskSummary);

  // Single task. Accepts JSON, form-encoded, or query-string `project`
  // — whichever is easiest to build from the agent's current shell.
  r.post('/api/tasks', handleTaskCreate);

  // Batch-create. Accepts EITHER:
  //   - application/json: { project?, tasks: [{title, description?}, ...] }
  //     or just [{title, description?}, ...] when project is in the query.
  //   - text/markdown: each `# Heading` starts a new task, lines below
  //     it become the description. Project must be in the query string.
  //
  // Markdown is the killer ergonomics path for shell agents: a heredoc
  // with single-quoted 'EOF' passes the body through with zero escaping.
  // Returns the created tasks in declaration order.
  r.post(
    '/api/tasks/batch',
    textBodyParser({ type: 'text/markdown', limit: '1mb' }),
    handleTaskBatchCreate,
  );

  // Bulk status transition. Saves agents from N PATCH round trips when
  // they're shepherding a batch of tasks (e.g. "mark every qa task done"
  // after reviewing the lane). Either explicit `ids` OR `fromStatus` +
  // `project` to target everything in a lane. Idempotent: tasks already
  // at the target status are no-op.
  // MUST be registered before `/api/tasks/:id` for path-specific routes to
  // keep winning over parameterized task-id routes.
  r.post('/api/tasks/transition', handleTaskTransition);

  r.get('/api/tasks/:id', handleTaskGet);

  r.patch('/api/tasks/:id', handleTaskUpdate);

  r.post('/api/tasks/reorder', handleTaskReorder);

  r.post('/api/tasks/:id/append-summary', handleTaskAppendSummary);

  r.delete('/api/tasks/:id', handleTaskDelete);

  return r;
}
