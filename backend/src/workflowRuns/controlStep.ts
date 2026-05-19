// Headless control-flow steps for autonomous workflow runs.
//
// Agent steps (the existing kind) spawn a Claude/Pi/Codex in a terminal and
// advance when the Stop hook calls /api/workflow-runs/.../complete. Control
// steps are different: they don't spawn an agent at all. They run server-side
// against Lattice's own task pipeline:
//
//   - 'start' moves every Open task to In Progress and runs each (same code
//     path as the Task Board "Run All" button). One terminal tab is emitted
//     per task so the user can watch / intervene.
//   - 'merge' waits for In Progress to drain (Phase A), then triggers merge
//     runs until Ready-to-Merge is empty (Phase B).
//   - 'push' waits for Ready-to-Merge to drain, then spawns a push session
//     (same code path as the Task Board cloud icon).
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

import { listTasks, subscribe as subscribeTasks } from '../tasks.js';
import type { Task, TaskStatus } from '../tasks.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
  type ProjectRunLockHandle,
} from '../projectRunLock.js';
import {
  cancelRun as cancelMergeRun,
  getRun as getMergeRun,
  startMergeRun,
  subscribe as subscribeMergeRuns,
} from '../mergeRuns.js';
import {
  getPushRun,
  startPushSession,
  subscribePushRuns,
} from '../pushRuns.js';
import { proxyKillSession } from '../terminalProxy.js';
import { startTaskById } from '../routes/tasks/startTask.js';
import { normalizeAgentHarness } from '../harnesses.js';
import type { Workflow, WorkflowStepKind } from '../workflows.js';
import { notify, snapshot, subscribe, type WorkflowRun } from './state.js';

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
      workerError = new Error(err.message);
    } else {
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

// ----------------------------------------------------------------------------
// 'start' — run every Open task
// ----------------------------------------------------------------------------

async function runStartStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  const tasks = await listTasks(wf.projectPath);
  const open = tasks
    .filter((t) => t.status === 'open')
    .sort((a, b) => a.createdAt - b.createdAt);

  if (open.length === 0) {
    emitControlProgress(run, stepIndex, 'start', 0, 0, 'no open tasks; skipping');
    return;
  }

  const harness = normalizeAgentHarness(run.harnessOverride);
  let started = 0;
  let failed = 0;
  emitControlProgress(
    run,
    stepIndex,
    'start',
    0,
    open.length,
    `starting ${open.length} task(s)`,
  );

  for (const task of open) {
    if (run.status !== 'running') return;
    try {
      const spawned = await startTaskById(task.id, backendOrigin, {
        requestedHarness: harness,
      });
      // Surface the spawned task agent as a terminal tab. Without this,
      // the pty is pre-warmed but no UI tab is ever attached, so the
      // user can't watch the agent run or intervene if it stalls.
      // Frontend useTaskTerminalCleanup auto-closes by taskId on lane
      // transition (when TaskBoard is mounted).
      notify({
        type: 'workflow-task-spawned',
        runId: run.id,
        projectPath: wf.projectPath,
        stepIndex,
        taskId: spawned.task.id,
        title: spawned.task.title,
        command: spawned.command,
        cwd: spawned.worktreePath,
        serverId: spawned.serverId,
      });
      started += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[workflow-run] ${run.id} start: task ${task.id} ("${task.title.slice(0, 60)}") failed:`,
        err,
      );
    }
    emitControlProgress(
      run,
      stepIndex,
      'start',
      started + failed,
      open.length,
      failed > 0
        ? `${started}/${open.length} started, ${failed} failed`
        : `${started}/${open.length} started`,
    );
  }
}

// ----------------------------------------------------------------------------
// 'merge' — drain In Progress, then drain Ready-to-Merge
// ----------------------------------------------------------------------------

async function runMergeStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  // Cancellation propagation: when the workflow run is cancelled, abort any
  // inner merge run we kicked off. Subscribe once for the whole step.
  let activeMergeRunId: string | null = null;
  const wfUnsub = subscribe((ev) => {
    if (ev.type !== 'cancelled') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (activeMergeRunId) {
      try {
        cancelMergeRun(activeMergeRunId);
      } catch {
        // best-effort
      }
    }
  });

  try {
    // Phase A: wait for In Progress to drain.
    emitControlProgress(
      run,
      stepIndex,
      'merge',
      0,
      1,
      'waiting for In Progress tasks to finish',
    );
    await waitForLaneEmpty(wf.projectPath, run, 'in_progress', (count, total) => {
      const finished = Math.max(0, total - count);
      emitControlProgress(
        run,
        stepIndex,
        'merge',
        finished,
        total,
        `In Progress draining: ${count} remaining`,
      );
    });
    if (run.status !== 'running') return;

    // Phase B: drain Ready-to-Merge. Loop until the lane is empty — a single
    // merge run may leave conflict-flagged tasks in flight (resolver Claudes),
    // and when they finalize the tasks pop back to ready_to_merge and we
    // re-run. Bail out if a merge run errors so we don't infinite-loop.
    let lastErrorCount = 0;
    while (run.status === 'running') {
      const cur = await listTasks(wf.projectPath);
      const ready = cur.filter((t) => t.status === 'ready_to_merge');
      if (ready.length === 0) break;

      emitControlProgress(
        run,
        stepIndex,
        'merge',
        0,
        ready.length,
        `merging ${ready.length} task(s)`,
      );

      const mergeRun = await startMergeRun(wf.projectPath, backendOrigin, {
        lockMode: 'inherit',
      });
      activeMergeRunId = mergeRun.id;
      await waitForMergeRunFinished(mergeRun.id);
      activeMergeRunId = null;
      if (run.status !== 'running') return;

      const finishedRun = getMergeRun(mergeRun.id);
      if (finishedRun && finishedRun.errored.length > lastErrorCount) {
        // New errors this round. If the lane is unchanged after the run,
        // we'd loop forever — surface the failure.
        lastErrorCount = finishedRun.errored.length;
        const afterTasks = await listTasks(wf.projectPath);
        const stillReady = afterTasks
          .filter((t) => t.status === 'ready_to_merge')
          .map((t) => t.id);
        const sameSet = stillReady.length === ready.length &&
          stillReady.every((id) => ready.some((r) => r.id === id));
        if (sameSet) {
          throw new Error(
            `merge run completed with ${finishedRun.errored.length} error(s) and ready-to-merge lane unchanged; aborting`,
          );
        }
      }
    }

    emitControlProgress(run, stepIndex, 'merge', 1, 1, 'merge complete');
  } finally {
    wfUnsub();
  }
}

function waitForMergeRunFinished(mergeRunId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Check in case it finished synchronously between startMergeRun returning
    // and our subscribe. Defensive — startMergeRun's worker is fire-and-forget
    // so this should never trigger, but cheap to verify.
    const initial = getMergeRun(mergeRunId);
    if (initial && initial.status !== 'running') {
      resolve();
      return;
    }
    const unsub = subscribeMergeRuns((ev) => {
      if (ev.type !== 'completed' && ev.type !== 'cancelled') return;
      if (ev.run.id !== mergeRunId) return;
      unsub();
      resolve();
    });
  });
}

// ----------------------------------------------------------------------------
// 'push' — drain Ready-to-Merge, then push
// ----------------------------------------------------------------------------

// Upper bound on how long the push step will wait for Claude's Stop hook. The
// session is "trust Claude to stop" (mirrors the Task Board cloud icon), but
// if Claude crashed before its Stop hook fired we'd otherwise hang the whole
// workflow forever. 15 minutes is generous for a normal git push, and dev
// restarts during the wait clear it anyway.
const PUSH_STEP_TIMEOUT_MS = 15 * 60 * 1000;

async function runPushStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  emitControlProgress(
    run,
    stepIndex,
    'push',
    0,
    1,
    'waiting for Ready to Merge to drain',
  );
  await waitForLaneEmpty(wf.projectPath, run, 'ready_to_merge', (count, total) => {
    emitControlProgress(
      run,
      stepIndex,
      'push',
      0,
      1,
      `Ready to Merge draining: ${count}/${total} remaining`,
    );
  });
  if (run.status !== 'running') return;

  emitControlProgress(run, stepIndex, 'push', 0, 1, 'pushing to remote');

  // Subscribe before spawning so we don't miss a fast 'done' event. The
  // session id isn't known until startPushSession returns, so the listener
  // captures it via closure once we have it.
  let sessionId: string | null = null;
  let sessionServerId: string | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const unsubPush = subscribePushRuns((ev) => {
    if (ev.type !== 'done') return;
    if (sessionId && ev.run.id === sessionId) resolveDone();
  });
  // Also resolve early if the workflow run is cancelled/errored. Without
  // this the await on `done` would hang until Claude's Stop hook fires (or
  // forever if the pty was already killed by something else), keeping the
  // project run-lock held the whole time.
  const unsubWf = subscribe((ev) => {
    if (ev.type !== 'cancelled' && ev.type !== 'errored') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (sessionServerId) {
      proxyKillSession(sessionServerId).catch(() => undefined);
    }
    resolveDone();
  });
  // Hard timeout backstop. If Claude crashed before the Stop hook fired the
  // workflow would otherwise wait forever. Log loud so the user can diagnose.
  const timeout = setTimeout(() => {
    console.warn(
      `[workflow-run] ${run.id} push step timed out after ${PUSH_STEP_TIMEOUT_MS}ms — resolving`,
    );
    if (sessionServerId) {
      proxyKillSession(sessionServerId).catch(() => undefined);
    }
    resolveDone();
  }, PUSH_STEP_TIMEOUT_MS);

  try {
    const session = await startPushSession(wf.projectPath, backendOrigin);
    sessionId = session.id;
    sessionServerId = session.serverId;

    // Surface the push terminal exactly like the Task Board cloud icon does:
    // emit a step-spawned event so useWorkflowRuns lazy-mounts a terminal tab.
    notify({
      type: 'step-spawned',
      runId: run.id,
      projectPath: wf.projectPath,
      stepIndex,
      command: session.command,
      cwd: session.cwd,
      serverId: session.serverId,
    });

    // Race condition guard: the Stop hook could conceivably fire between
    // startPushSession recording the run and our subscriber being attached
    // (subscriber is attached first; this is belt-and-suspenders).
    const current = getPushRun(session.id);
    if (current && current.status === 'done') resolveDone();

    await done;
    if (run.status !== 'running') return;
    emitControlProgress(run, stepIndex, 'push', 1, 1, 'push complete');
  } finally {
    clearTimeout(timeout);
    unsubPush();
    unsubWf();
  }
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

// Resolve when the given lane on `projectPath` is empty (count === 0) OR the
// workflow run is no longer 'running'. Snapshots `total` on first observation
// so progress reporting has a stable denominator.
//
// Subscribes to the task store BEFORE doing the initial read so we don't miss
// a transition that happens between read and subscribe. Also subscribes to
// workflow-run events so cancellation resolves the wait promptly (otherwise
// the lock would be held until something else nudges the task store).
function waitForLaneEmpty(
  projectPath: string,
  run: WorkflowRun,
  laneStatus: TaskStatus,
  onProgress: (count: number, total: number) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let total = 0;
    let totalCaptured = false;
    let settled = false;
    let unsubTasks: (() => void) | null = null;
    let unsubRun: (() => void) | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      unsubTasks?.();
      unsubRun?.();
      resolve();
    };

    const evaluate = (tasks: Task[]): boolean => {
      const count = tasks.filter((t) => t.status === laneStatus).length;
      if (!totalCaptured) {
        total = Math.max(count, 1);
        totalCaptured = true;
      }
      onProgress(count, total);
      return count === 0 || run.status !== 'running';
    };

    // Subscribe FIRST so a change between the initial listTasks and our
    // subscribe doesn't slip past us.
    unsubTasks = subscribeTasks((proj, tasks) => {
      if (proj !== projectPath) return;
      if (evaluate(tasks)) finish();
    });
    // Workflow-run cancellation: resolve the wait so the worker can exit
    // the control step (and release the project run-lock) promptly.
    unsubRun = subscribe((ev) => {
      if (!('run' in ev) || ev.run.id !== run.id) return;
      if (ev.type === 'cancelled' || ev.type === 'errored') finish();
    });

    void listTasks(projectPath).then((initial) => {
      if (settled) return;
      if (evaluate(initial)) finish();
    });
  });
}

function emitControlProgress(
  run: WorkflowRun,
  stepIndex: number,
  kind: WorkflowStepKind,
  current: number,
  total: number,
  message?: string,
): void {
  notify({
    type: 'step-control-progress',
    runId: run.id,
    projectPath: run.projectPath,
    stepIndex,
    kind,
    current,
    total,
    message,
  });
}
