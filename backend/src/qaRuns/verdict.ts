// Apply a QA e2e verdict: record it on the run and, when the agent is
// confident the merged feature passed, promote its task qa → done. Anything
// short of a confident pass (a fail, or a pass the agent isn't sure of) is
// left in the QA lane for a human to look at. This is the auto-advance that
// closes the QA → Done step when a Playwright session finishes cleanly.

import { getTask, updateTask } from '../tasks.js';
import { getQaRun, markQaRunMovedToDone, recordQaVerdict } from './registry.js';

export type QaVerdictInput = {
  passed: boolean;
  confident: boolean;
};

export type QaVerdictOutcome = {
  ok: true;
  // Was the run still tracked when the verdict arrived?
  tracked: boolean;
  // Did this verdict move the task into the Done lane?
  moved: boolean;
  // Human-readable why-not, present whenever `moved` is false.
  reason?: string;
};

export async function applyQaVerdict(
  runId: string,
  input: QaVerdictInput,
): Promise<QaVerdictOutcome> {
  const run = getQaRun(runId);
  if (!run) {
    // The Stop hook may have already fired /done and forgotten the run, or the
    // backend restarted. Nothing to advance — report it without erroring so a
    // late verdict curl doesn't surface as a failure in the agent transcript.
    return { ok: true, tracked: false, moved: false, reason: 'run not tracked' };
  }

  recordQaVerdict(runId, {
    passed: input.passed,
    confident: input.confident,
    receivedAt: Date.now(),
  });

  if (!input.passed) {
    return { ok: true, tracked: true, moved: false, reason: 'verdict: fail' };
  }
  if (!input.confident) {
    return { ok: true, tracked: true, moved: false, reason: 'pass but not confident' };
  }

  const task = await getTask(run.taskId);
  if (!task) {
    return { ok: true, tracked: true, moved: false, reason: 'task not found' };
  }
  // Only auto-advance from the QA lane — never resurrect a deleted/done task or
  // yank one back out of an earlier lane if the ids somehow disagree.
  if (task.status !== 'qa') {
    return {
      ok: true,
      tracked: true,
      moved: false,
      reason: `task not in qa (status=${task.status})`,
    };
  }

  const updated = await updateTask(run.taskId, { status: 'done' });
  if (!updated) {
    return { ok: true, tracked: true, moved: false, reason: 'task update failed' };
  }
  markQaRunMovedToDone(runId);
  return { ok: true, tracked: true, moved: true };
}
