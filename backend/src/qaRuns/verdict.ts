// Apply a QA e2e verdict: record it on the run and, when the agent is
// confident the merged feature passed, promote its task qa → done. Anything
// short of a confident pass (a fail, or a pass the agent isn't sure of) is
// left in the QA lane for a human to look at. This is the auto-advance that
// closes the QA → Done step when a Playwright session finishes cleanly.
//
// The transition has two triggers, mirroring how in_progress → ready_to_merge
// is driven by BOTH the model's explicit `/complete` curl AND the reliable,
// Lattice-controlled Stop hook / Pi completion extension (so it doesn't hinge
// on the model remembering): `applyQaVerdict` is the agent's explicit
// `/verdict` curl, and `applyRecordedQaVerdict` is the Stop-hook (`/done`)
// backstop that re-applies whatever verdict was recorded. Both funnel through
// `promoteOnConfidentPass`, which is idempotent, so either firing — or both —
// advances the task exactly once.

import { getTask, updateTask } from '../tasks.js';
import { getQaRun, markQaRunMovedToDone, recordQaVerdict } from './registry.js';
import type { QaRun } from './types.js';

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

// Shared promotion logic for both triggers. A confident pass on a still-`qa`
// task advances it qa → done; anything else is a guarded no-op. Idempotent:
// once `movedToDone` is set, a second trigger (or a duplicate /done) short-
// circuits, and the task-status guard means we never resurrect a deleted/done
// task or yank one back out of an earlier lane if the ids somehow disagree.
// The promotion in flight per run. `/verdict` and the `/done` backstop can land
// together (the agent's curl racing its own Stop hook): both used to pass the
// `movedToDone` check before either's `updateTask` resolved, so the task was
// written `done` twice and BOTH callers reported `moved: true`. A second
// trigger now waits for the first and then sees its result.
const promotions = new Map<string, Promise<QaVerdictOutcome>>();

async function promoteOnConfidentPass(
  run: QaRun,
  input: QaVerdictInput,
): Promise<QaVerdictOutcome> {
  if (!input.passed) {
    return { ok: true, tracked: true, moved: false, reason: 'verdict: fail' };
  }
  if (!input.confident) {
    return { ok: true, tracked: true, moved: false, reason: 'pass but not confident' };
  }
  const inFlight = promotions.get(run.id);
  if (inFlight) {
    await inFlight.catch(() => undefined);
    return promoteOnConfidentPass(run, input);
  }
  const promotion = promoteTask(run);
  promotions.set(run.id, promotion);
  try {
    return await promotion;
  } finally {
    if (promotions.get(run.id) === promotion) promotions.delete(run.id);
  }
}

async function promoteTask(run: QaRun): Promise<QaVerdictOutcome> {
  if (run.movedToDone) {
    // Already promoted by the earlier trigger (the /verdict curl, or a prior
    // /done). Nothing left to do.
    return { ok: true, tracked: true, moved: false, reason: 'already moved to done' };
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
  markQaRunMovedToDone(run.id);
  return { ok: true, tracked: true, moved: true };
}

// The agent's explicit `/verdict` curl. Records the verdict on the run, then
// applies it. This is the fast path — it advances the task the moment the
// agent reports, while the run is still tracked.
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

  return promoteOnConfidentPass(run, {
    passed: input.passed,
    confident: input.confident,
  });
}

// Stop-hook (`/done`) backstop. Re-applies whatever verdict the agent already
// recorded via /verdict, so the qa → done transition fires from the reliable,
// Lattice-controlled Stop hook rather than hinging on the agent's separate
// /verdict curl landing — exactly the redundancy in_progress → ready_to_merge
// has (Stop hook / Pi extension on top of the model's own curl). If the
// explicit curl already promoted the task this is an idempotent no-op; if its
// move was missed (a transient updateTask failure, or a verdict/`done` race)
// this finalizes it. No recorded verdict ⇒ nothing to apply, and the task is
// left in QA for a human — the same outcome as a fail or an unsure pass.
export async function applyRecordedQaVerdict(
  runId: string,
): Promise<QaVerdictOutcome> {
  const run = getQaRun(runId);
  if (!run) {
    return { ok: true, tracked: false, moved: false, reason: 'run not tracked' };
  }
  if (!run.verdict) {
    return { ok: true, tracked: true, moved: false, reason: 'no verdict recorded' };
  }
  return promoteOnConfidentPass(run, {
    passed: run.verdict.passed,
    confident: run.verdict.confident,
  });
}
