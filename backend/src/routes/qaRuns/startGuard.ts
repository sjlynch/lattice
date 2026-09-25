// Request validation + task-ownership + status + duplicate-run guards for POST /api/qa-runs,
// kept out of the route body so the handler is just "resolve → spawn → shape".
// Returns a discriminated result the route maps straight onto a status/JSON:
// an `ok:false` carries the exact status code + error string the route must
// send; an `ok:true` carries the canonicalized project and the resolved task.

import { canonicalProjectPath, isRealAbsoluteProjectPath } from '../../projectPath.js';
import { relativeProjectError } from '../projectParam.js';
import { getTask } from '../../tasks.js';
import type { Task } from '../../tasks.js';
import type { QaRun } from '../../qaRuns.js';
import { findStepSessionId, type ProbedSession } from '../../workflowRuns/resumeDecision.js';

export type QaRunStartResolution =
  | { ok: false; status: number; error: string }
  | { ok: true; project: string; task: Task };

export async function resolveQaRunStart(
  body: unknown,
  lookupTask: typeof getTask,
): Promise<QaRunStartResolution> {
  const b = (body || {}) as { project?: unknown; taskId?: unknown };
  const rawProject = typeof b.project === 'string' ? b.project.trim() : '';
  if (!rawProject) return { ok: false, status: 400, error: 'project required' };
  // canonicalProjectPath is path.resolve underneath: a relative project would
  // resolve under the backend's cwd and never match the task's board anyway.
  if (!isRealAbsoluteProjectPath(rawProject)) {
    return { ok: false, status: 400, error: relativeProjectError(rawProject) };
  }
  if (typeof b.taskId !== 'string' || !b.taskId) {
    return { ok: false, status: 400, error: 'taskId required' };
  }
  const project = canonicalProjectPath(rawProject);

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

// Where the duplicate check reads the tracked runs and the live ptys. Injected
// by the route-level regression test; production uses the real registry and
// terminal-server probe.
export type ActiveQaRunDeps = {
  listRunningRuns: () => readonly QaRun[];
  listSessions: () => Promise<readonly unknown[] | null>;
};

// The still-running QA run already testing this task, if any. A second session
// for the same task would drive the browser against the same dev server beside
// the first and post its own verdict — either confident PASS promotes the task
// — so the route refuses the start while one is found.
//
// A run whose pty is definitively gone (the user closed its tab, so no /done
// ever came) stays `running` in the registry until boot recovery settles it;
// it must not block a re-test forever, so it doesn't count. When the
// terminal-server can't be probed, a tracked run is assumed alive: refusing a
// maybe-duplicate beats spawning a second session.
export async function findActiveQaRunForTask(
  project: string,
  taskId: string,
  deps: ActiveQaRunDeps,
): Promise<QaRun | null> {
  const candidates = deps.listRunningRuns().filter((r) => {
    if (r.taskId !== taskId) return false;
    try {
      return canonicalProjectPath(r.projectPath) === project;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return null;
  const sessions = (await deps.listSessions()) as readonly ProbedSession[] | null;
  if (sessions === null) return candidates[0];
  return candidates.find((r) => findStepSessionId(sessions, r.cwd) !== null) ?? null;
}
