// 'start' control step — run every Open task.
//
// Moves every Open task to In Progress and runs each (same code path as the
// Task Board "Run All" button), emitting one terminal tab per task so the
// user can watch / intervene.

import { listTasks } from '../../tasks.js';
import { startTaskById } from '../../routes/tasks/startTask.js';
import { enqueueTaskRun } from '../../routes/tasks/queuedSpawn.js';
import { isSpawnDeferral, isSpawnDiskSpaceError } from '../../spawnQueue.js';
import { normalizeAgentHarness, type AgentHarness } from '../../harnesses.js';
import { normalizePiModel } from '../../piModels.js';
import { getUserSettings } from '../../userSettings.js';
import type { Workflow } from '../../workflows.js';
import { notify, type WorkflowRun } from '../state.js';
import { emitControlProgress } from './shared.js';

// Injectable seam (production default below). Mirrors merge.ts's MergeStepDeps:
// the hard-cap handling (Fix 1) is the subtle part, so the regression test
// overrides `startTask` to simulate a terminal-server cap rejection without
// spawning a real worktree/pty and asserts the capped task is neither counted
// as started nor left in_progress-without-agent.
export type StartStepDeps = {
  listTasks: typeof listTasks;
  startTask: typeof startTaskById;
  enqueueRun: typeof enqueueTaskRun;
};

const productionDeps: StartStepDeps = {
  listTasks,
  startTask: startTaskById,
  enqueueRun: enqueueTaskRun,
};

// The Pi model the Start step's spawned task agents should use FOR A RUN-LEVEL
// OVERRIDE. Mirrors the run-level harness resolution and `effectiveStepPiModel`
// for regular workflow steps: the run's `piModelOverride` applies, but only
// when the run is a Pi run (Claude/codex ignore it, and a non-pi run must not
// pin a Pi model). Returns undefined otherwise so `startTaskById` falls back to
// the per-project default Pi model. Without this the Start step silently
// dropped the override and every spawned task ran on the project/default model.
// (The no-override case — the per-project DEFAULT harness/model — is resolved by
// `resolveStartStepHarnessPicker`.)
export function startStepTaskPiModel(
  run: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>,
): string | undefined {
  return normalizeAgentHarness(run.harnessOverride) === 'pi'
    ? run.piModelOverride
    : undefined;
}

export type StartStepTaskHarness = {
  harness: AgentHarness;
  piModel: string | undefined;
};

// Resolves the harness + Pi model the Start step should spawn each Open task on,
// mirroring the Task Board "Run All" path this step documents itself as matching:
//   - A run-level harness override pins EVERY spawned task to that harness (and,
//     for a Pi override, its `piModelOverride`) — the override case.
//   - With NO override, the per-project default applies — exactly like Run All,
//     which sends `UserSettings.harness` / `piModel` on each /run. `interleave`
//     is expanded the way the UI's `pickRunHarness` does: alternate claude/pi
//     across consecutive tasks (starting on claude), so a Start step over N Open
//     tasks produces the same claude/pi mix Run All would. Pi picks carry the
//     project's default Pi model; claude/codex picks never pin one.
// Resolving the per-project default ONCE (one settings read) returns a picker
// `(taskIndex) => {harness, piModel}`; `taskIndex` only matters for interleave.
//
// Without this the Start step hardcoded `normalizeAgentHarness(harnessOverride)`,
// which is `'claude'` whenever the run has no override (the common case) — so a
// project whose default harness is Pi/Codex got every workflow-started task
// silently forced onto Claude.
export async function resolveStartStepHarnessPicker(
  run: Pick<WorkflowRun, 'harnessOverride' | 'piModelOverride'>,
  projectPath: string,
): Promise<(taskIndex: number) => StartStepTaskHarness> {
  // Run-level override → pin every task to that harness + its Pi model override.
  if (run.harnessOverride) {
    const harness = normalizeAgentHarness(run.harnessOverride);
    const piModel = startStepTaskPiModel(run);
    return () => ({ harness, piModel });
  }
  // No override → the per-project default, read from UserSettings like Run All.
  const settings = await getUserSettings(projectPath);
  const piModel = normalizePiModel(settings.piModel);
  if (settings.harness === 'interleave') {
    return (taskIndex) => {
      const harness: AgentHarness = taskIndex % 2 === 0 ? 'claude' : 'pi';
      return { harness, piModel: harness === 'pi' ? piModel : undefined };
    };
  }
  const harness = normalizeAgentHarness(settings.harness);
  return () => ({ harness, piModel: harness === 'pi' ? piModel : undefined });
}

export async function runStartStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: StartStepDeps = productionDeps,
): Promise<void> {
  const tasks = await deps.listTasks(wf.projectPath);
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
  // Resolve the harness/Pi-model the same way the Task Board "Run All" button
  // does — a run-level override pins every task, otherwise the per-project
  // default harness applies (interleave expands to a claude/pi mix). Resolved
  // once here, applied per task below.
  const pickHarness = await resolveStartStepHarnessPicker(run, wf.projectPath);
  let started = 0;
  let failed = 0;
  // Tasks that hit the terminal-server hard cap: left Open and re-queued on the
  // spawn queue rather than force-flipped to in_progress with no agent (Fix 1).
  // They are NOT counted as started (there is no live agent yet) and NOT as
  // failed (a cap rejection isn't an error — the queue will start them when a
  // slot frees). Tracked separately so the "no progress" throw below can tell a
  // genuinely-failed run from one that merely overflowed the cap.
  let deferred = 0;
  let firstError: string | null = null;
  emitControlProgress(
    run,
    stepIndex,
    'start',
    0,
    open.length,
    `starting ${open.length} task(s)`,
  );

  for (const [index, task] of open.entries()) {
    if (run.status !== 'running') return;
    const { harness, piModel } = pickHarness(index);
    try {
      // throwOnCapacity: a terminal-server hard-cap rejection must throw
      // (SpawnCapacityError) instead of being swallowed. Without it startTaskById
      // still flips the task open → in_progress with NO pty/agent (and we'd count
      // it as started) — the excess tasks then sit in_progress forever with no
      // commit, which is exactly what later hangs the Merge control step.
      const spawned = await deps.startTask(task.id, backendOrigin, {
        requestedHarness: harness,
        requestedPiModel: piModel,
        throwOnCapacity: true,
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
        terminalId: spawned.terminalId,
      });
      started += 1;
      console.log(
        `[workflow-run] ${run.id} start step: task ${task.id} ("${task.title.slice(0, 60)}") → in_progress`,
      );
    } catch (err) {
      if (isSpawnDeferral(err)) {
        // Hard cap: startTaskById threw BEFORE flipping status, so the task is
        // still Open (no phantom in_progress, no orphan pty). Re-enqueue it on
        // the spawn queue — the same path Run All uses — so it starts when a
        // slot frees. Don't count it as started or failed.
        deferred += 1;
        try {
          await deps.enqueueRun(task.id, backendOrigin, harness, piModel);
        } catch (enqErr) {
          console.error(
            `[workflow-run] ${run.id} start step: failed to re-queue capped task ${task.id}:`,
            enqErr,
          );
        }
        // A disk-space deferral takes the same path: no worktree was created,
        // the task is still Open, and the queue starts it once there is room.
        console.warn(
          `[workflow-run] ${run.id} start step: task ${task.id} ("${task.title.slice(0, 60)}") ` +
            (isSpawnDiskSpaceError(err)
              ? `is waiting for disk space (${err.message}) — left Open and re-queued on the spawn queue`
              : 'hit the terminal-server hard cap — left Open and re-queued on the spawn queue'),
        );
      } else {
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
    }
    emitControlProgress(
      run,
      stepIndex,
      'start',
      started + failed + deferred,
      open.length,
      startProgressMessage(open.length, started, failed, deferred),
    );
  }

  // If the step had open tasks but moved NONE of them forward — neither started
  // nor re-queued — and something genuinely failed, it accomplished nothing:
  // throw so the workflow errors with the real underlying message (e.g. a
  // worktree-creation failure) instead of silently advancing to merge/push,
  // which then find nothing to do and the whole run "succeeds" having done no
  // work. A cap-deferred task IS forward progress (it's queued), so a run that
  // only overflowed the cap must not throw here.
  if (started === 0 && deferred === 0 && failed > 0) {
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
  // Cap-deferred tasks are queued, not dropped — but note them so the overflow
  // isn't invisible either.
  if (deferred > 0) {
    console.warn(
      `[workflow-run] ${run.id} start step: ${deferred} task(s) hit the terminal-server ` +
        `hard cap and were re-queued on the spawn queue — they start as slots free`,
    );
  }
}

function startProgressMessage(
  total: number,
  started: number,
  failed: number,
  deferred: number,
): string {
  let msg = `${started}/${total} started`;
  if (failed > 0) msg += `, ${failed} failed`;
  if (deferred > 0) msg += `, ${deferred} queued`;
  return msg;
}
