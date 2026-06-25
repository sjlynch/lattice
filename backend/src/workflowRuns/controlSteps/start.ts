// 'start' control step — run every Open task.
//
// Moves every Open task to In Progress and runs each (same code path as the
// Task Board "Run All" button), emitting one terminal tab per task so the
// user can watch / intervene.

import { listTasks } from '../../tasks.js';
import { startTaskById } from '../../routes/tasks/startTask.js';
import { normalizeAgentHarness } from '../../harnesses.js';
import type { Workflow } from '../../workflows.js';
import { notify, type WorkflowRun } from '../state.js';
import { emitControlProgress } from './shared.js';

// The Pi model the Start step's spawned task agents should use. Mirrors the
// run-level harness resolution and `effectiveStepPiModel` for regular workflow
// steps: the run's `piModelOverride` applies, but only when the run is a Pi run
// (Claude/codex ignore it, and a non-pi run must not pin a Pi model). Returns
// undefined otherwise so `startTaskById` falls back to the per-project default
// Pi model. Without this the Start step silently dropped the override and every
// spawned task ran on the project/default model — the bug this fixes.
export function startStepTaskPiModel(
  run: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>,
): string | undefined {
  return normalizeAgentHarness(run.harnessOverride) === 'pi'
    ? run.piModelOverride
    : undefined;
}

export async function runStartStep(
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
    console.log(
      `[workflow-run] ${run.id} start step: no open tasks for ${wf.projectPath} — skipping`,
    );
    emitControlProgress(run, stepIndex, 'start', 0, 0, 'no open tasks; skipping');
    return;
  }

  console.log(
    `[workflow-run] ${run.id} start step: moving ${open.length} open task(s) → in_progress`,
  );
  const harness = normalizeAgentHarness(run.harnessOverride);
  const requestedPiModel = startStepTaskPiModel(run);
  let started = 0;
  let failed = 0;
  let firstError: string | null = null;
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
        requestedPiModel,
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
      console.log(
        `[workflow-run] ${run.id} start step: task ${task.id} ("${task.title.slice(0, 60)}") → in_progress`,
      );
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (firstError === null) firstError = message;
      // console.error (not warn): a task that can't be started is the whole
      // point of this step failing — make it loud in the backend log.
      console.error(
        `[workflow-run] ${run.id} start step: task ${task.id} ("${task.title.slice(0, 60)}") failed to start:`,
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

  // If the step had open tasks but moved NONE of them to in_progress, it
  // accomplished nothing — throw so the workflow errors with the real
  // underlying message (e.g. a worktree-creation failure) instead of
  // silently advancing to merge/push, which then find nothing to do and the
  // whole run "succeeds" having done no work. That silent-success path is
  // exactly the "workflow runs through but the start step never moved my
  // tasks" symptom — the failure was swallowed into a console.warn.
  if (started === 0 && failed > 0) {
    throw new Error(
      `start step: all ${failed} task(s) failed to move from open → in_progress. ` +
        `First failure: ${firstError ?? 'unknown error'}`,
    );
  }
  // Partial failure: the started tasks still proceed; just log it loudly so
  // the dropped tasks aren't invisible.
  if (failed > 0) {
    console.warn(
      `[workflow-run] ${run.id} start step finished with ${started} started, ${failed} failed — ` +
        `the ${failed} failed task(s) remain in the open lane`,
    );
  }
}
