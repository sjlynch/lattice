// Headless control-flow steps for autonomous workflow runs.
//
// Agent steps (the existing kind) spawn a Claude/Pi/Codex in a terminal and
// advance when the Stop hook calls /api/workflow-runs/.../complete. Control
// steps are different: they don't spawn an agent at all. They run server-side
// against Lattice's own task pipeline:
//
//   - 'start' moves every Open task to In Progress and runs each (same code
//     path as the Task Board "Run All" button). One terminal tab is emitted
//     per task so the user can watch / intervene. (controlSteps/start.ts)
//   - 'merge' waits for In Progress to drain (Phase A), then triggers merge
//     runs until Ready-to-Merge is empty (Phase B). (controlSteps/merge.ts)
//   - 'push' waits for Ready-to-Merge to drain, then spawns a push session
//     (same code path as the Task Board cloud icon). (controlSteps/push.ts)
//
// This file is the thin dispatcher: it owns the per-project run-lock lifecycle
// and the kind→worker routing. The lane-wait subscription and progress
// notification helpers live in controlSteps/shared.ts; each per-kind worker
// lives in its own controlSteps/<kind>.ts module.
//
// Each control step acquires the per-project run-lock for its kind-specific
// worker so dev.mjs defers backend restarts while it's waiting, and a manual
// merge run can't race against the workflow. The lock is released BEFORE we
// call completeStep so the next step (often another control step) can
// acquire its own lock without racing the previous step's release.
//
// The orchestrator (workflowRuns.ts) dispatches to executeControlStep for
// non-agent steps. We take a `completeStep` callback rather than importing
// completeWorkflowStep directly to avoid the circular import — the
// orchestrator passes itself in.

import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import type { Workflow, WorkflowStepKind } from '../workflows.js';
import { notify, snapshot, type WorkflowRun } from './state.js';
import { runStartStep } from './controlSteps/start.js';
import { runMergeStep } from './controlSteps/merge.js';
import { runPushStep } from './controlSteps/push.js';

export type CompleteStepCallback = (
  runId: string,
  stepIndex: number,
  backendOrigin: string,
) => Promise<void>;

// Fire-and-forget orchestration entry point. Mirrors spawnWorkflowStep's
// shape (called by the orchestrator, returns quickly) but the long-running
// work continues in a worker that calls completeStep itself when done.
export function executeControlStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): void {
  void runControlStepWorker(wf, run, stepIndex, backendOrigin, completeStep);
}

async function runControlStepWorker(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  completeStep: CompleteStepCallback,
): Promise<void> {
  const step = wf.steps[stepIndex];
  const kind: WorkflowStepKind = step.kind ?? 'agent';
  const lockLabel = `workflow-${kind}:${run.id}`;

  let lock: ProjectRunLockHandle | null = null;
  let workerError: Error | null = null;

  try {
    lock = await acquireProjectRunLock(wf.projectPath, lockLabel);
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      // Log loud — historically this is the most common reason a workflow
      // appears to "abort right after step N": a previous run's lock
      // wasn't cleared (dev restart, stuck hook, etc.). The wrapped
      // message goes into run.error and is also surfaced via WS.
      console.warn(
        `[workflow-run] ${run.id} step ${stepIndex} (${kind}) ` +
          `could not acquire project run lock: ${err.message}`,
      );
      workerError = new Error(err.message);
    } else {
      console.error(
        `[workflow-run] ${run.id} step ${stepIndex} (${kind}) ` +
          `acquire threw:`,
        err,
      );
      workerError = err as Error;
    }
  }

  if (!workerError && lock) {
    console.log(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) starting`,
    );
    try {
      if (kind === 'start') {
        await runStartStep(wf, run, stepIndex, backendOrigin);
      } else if (kind === 'merge') {
        await runMergeStep(wf, run, stepIndex, backendOrigin);
      } else if (kind === 'push') {
        await runPushStep(wf, run, stepIndex, backendOrigin);
      } else {
        throw new Error(`unsupported control-step kind: ${kind}`);
      }
    } catch (err) {
      workerError = err as Error;
    } finally {
      // Release the lock BEFORE calling completeStep. The next step (often
      // another control step) acquires its own lock; if we held this one
      // across completeStep the acquire would race against our release.
      await lock.release().catch(() => undefined);
      lock = null;
    }
  }

  if (workerError) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = workerError.message ?? 'control step failed';
    notify({ type: 'errored', run: snapshot(run) });
    console.error(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) failed:`,
      workerError,
    );
    return;
  }

  if (run.status !== 'running') {
    // Workflow run was cancelled mid-step. Don't advance.
    console.log(
      `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) ended in ${run.status}; not advancing`,
    );
    return;
  }

  console.log(
    `[workflow-run] ${run.id} control step ${stepIndex} (${kind}) finished, advancing`,
  );
  await completeStep(run.id, stepIndex, backendOrigin);
}
