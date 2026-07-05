// Request validation + task-ownership + status guards for POST /api/qa-runs,
// kept out of the route body so the handler is just "resolve → spawn → shape".
// Returns a discriminated result the route maps straight onto a status/JSON:
// an `ok:false` carries the exact status code + error string the route must
// send; an `ok:true` carries the canonicalized project and the resolved task.

import { canonicalProjectPath } from '../../projectPath.js';
import { getTask } from '../../tasks.js';
import type { Task } from '../../tasks.js';

export type QaRunStartResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; project: string; task: Task };

export async function resolveQaRunStart(
  body: unknown,
  lookupTask: typeof getTask,
): Promise<QaRunStartResolution> {
  const b = (body || {}) as { project?: string; taskId?: string };
  if (!b.project) return { ok: false, status: 400, error: 'project required' };
  if (!b.taskId) return { ok: false, status: 400, error: 'taskId required' };
  const project = canonicalProjectPath(b.project);

  const task = await lookupTask(b.taskId);
  if (!task) return { ok: false, status: 404, error: 'task not found' };
  // Defensive: a QA run only makes sense against the task's own project.
  if (canonicalProjectPath(task.projectPath) !== project) {
    return { ok: false, status: 400, error: 'task does not belong to project' };
  }
  // A QA e2e session only makes sense for a task that's actually in the QA
  // lane (merged, awaiting verification). Starting one for an
  // open/in_progress/ready_to_merge/done task — via a stale/miswired frontend
  // call or a direct API hit — would burn an agent/PTY exercising unmerged or
  // already-shipped code and append a misleading verdict; worse, if that task
  // later reaches QA, a confident PASS recorded from this stale run could
  // promote it to done against the wrong code state. Reject and spawn nothing.
  if (task.status !== 'qa') {
    return {
      ok: false,
      status: 409,
      error: `task is not in QA (status=${task.status})`,
    };
  }

  return { ok: true, project, task };
}
