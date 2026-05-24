// Plain CRUD / list / batch / transition / reorder routes for tasks.
// No worktree spawning, no merge orchestration — just data manipulation.

import { Router, text as textBodyParser } from 'express';
import {
  handleProjectsList,
  handleTaskAppendSummary,
  handleTaskBatchCreate,
  handleTaskBulkUpdate,
  handleTaskCancelQueuedRun,
  handleTaskCreate,
  handleTaskDelete,
  handleTaskGet,
  handleTaskList,
  handleTaskReorder,
  handleTaskSummary,
  handleTaskTransition,
  handleTaskUpdate,
  handleTaskUpsert,
} from './crudHandlers.js';

// Body parser shared by every route that accepts markdown OR plain-text
// bodies in addition to JSON. Lets agents pipe heredocs through curl with
// zero JSON escaping.
const textOrMarkdownBody = textBodyParser({
  type: ['text/markdown', 'text/plain'],
  limit: '1mb',
});

export function buildTaskCrudRouter(): Router {
  const r = Router();

  // Project roots Lattice has indexed. Cheap "what projects exist" probe
  // for harness-spawned agents in ambiguous cwds.
  r.get('/api/projects', handleProjectsList);

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
  r.post('/api/tasks/batch', textOrMarkdownBody, handleTaskBatchCreate);

  // Bulk update — N {id, patch} updates in one round trip. JSON only;
  // multi-line descriptions go through the markdown upsert path below.
  r.post('/api/tasks/bulk-update', handleTaskBulkUpdate);

  // Upsert from markdown (or JSON). Headings with `{id=...}` update
  // existing tasks; headings without an id create new ones. The natural
  // partner to GET /api/tasks?format=markdown for round-trip editing.
  r.post('/api/tasks/upsert', textOrMarkdownBody, handleTaskUpsert);

  // Bulk status transition. Saves agents from N PATCH round trips when
  // they're shepherding a batch of tasks (e.g. "mark every qa task done"
  // after reviewing the lane). Either explicit `ids` OR `fromStatus` +
  // `project` to target everything in a lane. Idempotent: tasks already
  // at the target status are no-op.
  // MUST be registered before `/api/tasks/:id` for path-specific routes to
  // keep winning over parameterized task-id routes.
  r.post('/api/tasks/transition', handleTaskTransition);

  r.get('/api/tasks/:id', handleTaskGet);

  // PATCH accepts JSON or text/markdown / text/plain. Markdown body
  // replaces the description (and the title, if a `# Heading` is present).
  // Avoids JSON quoting hell for multi-line description refinements.
  r.patch('/api/tasks/:id', textOrMarkdownBody, handleTaskUpdate);

  r.post('/api/tasks/reorder', handleTaskReorder);

  // /append-summary accepts JSON ({summary}) or text/markdown / text/plain
  // (whole body becomes the summary).
  r.post('/api/tasks/:id/append-summary', textOrMarkdownBody, handleTaskAppendSummary);

  // Drop a queued task run back to a plain Open task.
  r.post('/api/tasks/:id/cancel-queued-run', handleTaskCancelQueuedRun);

  r.delete('/api/tasks/:id', handleTaskDelete);

  return r;
}
