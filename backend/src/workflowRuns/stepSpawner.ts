// Materializes one workflow step on disk and pre-spawns its terminal.
//
// Per-step setup: create .lattice/workflow-steps/<runId>/step-<N>/, write
// WORKFLOW_STEP.md + create-task.cjs, install the Stop hook (Claude) and
// session_shutdown extension (Pi), build the harness command, ask the
// terminal-server to allocate a pty, then fan out 'step-spawned' +
// 'progress' WS events. The pty is pre-spawned so the frontend can
// lazy-mount its terminal pane without burning a WebGL context for a step
// the user may never click into.
//
// This file is the coordinator; the moving parts live alongside it:
//   scratchDirectory.ts — scratch README + run-dir pruning
//   commandBuilder.ts    — harness command assembly
//   sessionSpawner.ts    — spawn-queue orchestration + agent-session presence

import path from 'node:path';
import fs from 'node:fs/promises';
import { installClaudeHooks } from '../claudeStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { buildAgentActivityUrl } from '../agentActivity.js';
import type { Workflow } from '../workflows.js';
import { renderHelperScript } from './renderHelperScript.js';
import { effectiveStepHarness, renderStepMarkdown } from './stepMarkdown.js';
import { getProjectDirtyState } from './projectDirtyState.js';
import { notify, snapshot, type WorkflowRun } from './state.js';
import { pruneOldWorkflowRuns, writeScratchReadme } from './scratchDirectory.js';
import { buildWorkflowStepCommand } from './commandBuilder.js';
import { enqueueWorkflowStepSession, workflowStepAgentId } from './sessionSpawner.js';

// Re-export the public surface so existing importers (routes/workflows.ts,
// the workflowScratchPrune test) keep resolving these from stepSpawner.
export { pruneOldWorkflowRuns, writeScratchReadme } from './scratchDirectory.js';
export { workflowStepAgentId } from './sessionSpawner.js';

export async function spawnWorkflowStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<{ command: string; cwd: string }> {
  const workflowStepsRoot = path.join(wf.projectPath, '.lattice', 'workflow-steps');
  const runDir = path.join(workflowStepsRoot, run.id);
  const stepDir = path.join(runDir, `step-${stepIndex}`);
  await fs.mkdir(stepDir, { recursive: true });
  // Mark the run dir as scratch (and prune older runs) on the first step.
  // Done after mkdir so the run dir definitely exists; idempotent on later
  // steps because writeScratchReadme no-ops if the README is already there.
  await writeScratchReadme(runDir);
  if (stepIndex === 0) {
    await pruneOldWorkflowRuns(workflowStepsRoot, run.id);
  }

  const stepFile = path.join(stepDir, 'WORKFLOW_STEP.md');
  const harness = effectiveStepHarness(wf, run, stepIndex);
  // Best-effort working-tree-drift probe — if the project repo has
  // uncommitted changes, the rendered WORKFLOW_STEP.md gets a warning
  // banner so the planner doesn't synthesize tasks against paths that
  // only exist on disk (worktrees check out HEAD, not the working tree).
  // Probe failures resolve to `null` and just suppress the banner.
  const dirtyState = await getProjectDirtyState(wf.projectPath);
  if (dirtyState) {
    const total =
      dirtyState.modified.length + dirtyState.deleted.length + dirtyState.untracked.length;
    console.log(
      `[workflow-step] ${run.id} step ${stepIndex}: project working tree is dirty ` +
        `(${dirtyState.modified.length}M / ${dirtyState.deleted.length}D / ${dirtyState.untracked.length}?? = ${total} paths); ` +
        `injecting divergence warning into WORKFLOW_STEP.md`,
    );
  }
  await fs.writeFile(
    stepFile,
    renderStepMarkdown(wf, run, stepIndex, backendOrigin, dirtyState),
    'utf8',
  );

  // Helper script so the agent can create tasks without shell quoting issues.
  await fs.writeFile(
    path.join(stepDir, 'create-task.cjs'),
    renderHelperScript(wf.projectPath, backendOrigin),
    'utf8',
  );

  const completionUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  // Always install BOTH backstops regardless of harness (defence-in-depth):
  // a harness switch mid-run would otherwise lose the callback, and the
  // unused one is inert. The Pi gate is disabled here because the workflow-
  // step `/complete` route has no destructive side effect — abnormal exits
  // should still advance the run rather than wedge it.
  //
  // The Claude Stop hook URL carries `?source=` so the /complete log line
  // can identify the firing mechanism; the Pi extension does the same via
  // piExtension.ts.
  await installClaudeHooks(stepDir, {
    completeUrl: `${completionUrl}?source=claude-stop-hook-workflow-step-complete`,
    activityUrl: buildAgentActivityUrl(backendOrigin, {
      agentId: workflowStepAgentId(run.id, stepIndex),
      projectPath: wf.projectPath,
      label: `workflow step ${stepIndex + 1}`,
    }),
  });
  await installPiCompletionExtension({
    dir: stepDir,
    callbackUrl: completionUrl,
    site: 'workflow-step-complete',
    respectQuitGate: false,
  });
  console.log(
    `[workflow-step] installed Claude+Pi backstops for run ${run.id} step ${stepIndex} ` +
      `(active harness=${harness}, dir=${stepDir})`,
  );

  const command = buildWorkflowStepCommand(stepFile, harness);

  enqueueWorkflowStepSession({
    run,
    stepIndex,
    projectPath: wf.projectPath,
    stepDir,
    command,
    harness,
  });

  // Emit progress now — the step is the run's current step whether its pty
  // is spawning immediately or waiting in the queue.
  notify({ type: 'progress', run: snapshot(run) });

  return { command, cwd: stepDir };
}
