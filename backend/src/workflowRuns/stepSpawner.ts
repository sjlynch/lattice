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
import { installCodexStopHook } from '../codexStopHook.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import { buildAgentActivityUrl } from '../agentActivityTokens.js';
import type { Workflow, WorkflowStepHarness } from '../workflows.js';
import { renderHelperScript } from './renderHelperScript.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { isCodexYoloEnabled } from '../userSettings.js';
import {
  effectiveStepHarness,
  effectiveStepPiModel,
  renderStepMarkdown,
} from './stepMarkdown.js';
import { getProjectDirtyState, type DirtyStateSummary } from './projectDirtyState.js';
import { getRunningRunIds, notify, snapshot, type WorkflowRun } from './state.js';
import {
  pruneOldWorkflowRuns,
  workflowRunDir,
  workflowStepDir,
  workflowStepsRootDir,
  writeScratchReadme,
} from './scratchDirectory.js';
import { buildWorkflowStepCommand } from './commandBuilder.js';
import { enqueueWorkflowStepSession, workflowStepAgentId } from './sessionSpawner.js';
import { beginStepPreRun, endStepPreRun, runStepTools } from './stepTools.js';

// Re-export the public surface so existing importers (routes/workflows/runs.ts,
// the workflowScratchPrune test) keep resolving these from stepSpawner.
export { pruneOldWorkflowRuns, writeScratchReadme } from './scratchDirectory.js';
export { killWorkflowStepSession, workflowStepAgentId } from './sessionSpawner.js';

type PreparedStepScratch = {
  workflowStepsRoot: string;
  runDir: string;
  stepDir: string;
  stepFile: string;
};

async function prepareStepScratch(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
): Promise<PreparedStepScratch> {
  const workflowStepsRoot = workflowStepsRootDir(wf.projectPath);
  const runDir = workflowRunDir(wf.projectPath, run.id);
  const stepDir = workflowStepDir(wf.projectPath, run.id, stepIndex);
  await fs.mkdir(stepDir, { recursive: true });
  // Mark the run dir as scratch (and prune older runs) the first time this run
  // materializes its scratch dir. Done after mkdir so the run dir definitely
  // exists; writeScratchReadme returns true only on that first materialization
  // (it no-ops once the README is present), so prune runs exactly once per run.
  //
  // We key off that signal rather than `stepIndex === 0` on purpose: control
  // steps (start/merge/push) run headless and never call spawnWorkflowStep, so
  // for a start-first workflow the first spawn here is at stepIndex >= 1. The
  // old `=== 0` guard meant pruning never ran for such runs and the wfrun_*
  // scratch grew without bound.
  const freshRunDir = await writeScratchReadme(runDir);
  if (freshRunDir) {
    // Exclude every run still `running` for this project, not just the one we
    // are spawning into: concurrent runs are allowed, and a run parked on a
    // long agent step would otherwise be prunable (stale run-dir mtime) even
    // though the backend still intends to advance it.
    await pruneOldWorkflowRuns(workflowStepsRoot, run.id, getRunningRunIds(wf.projectPath));
  }
  return {
    workflowStepsRoot,
    runDir,
    stepDir,
    stepFile: path.join(stepDir, 'WORKFLOW_STEP.md'),
  };
}

function logDirtyState(run: WorkflowRun, stepIndex: number, dirtyState: DirtyStateSummary): void {
  const total =
    dirtyState.modified.length + dirtyState.deleted.length + dirtyState.untracked.length;
  console.log(
    `[workflow-step] ${run.id} step ${stepIndex}: project working tree is dirty ` +
      `(${dirtyState.modified.length}M / ${dirtyState.deleted.length}D / ${dirtyState.untracked.length}?? = ${total} paths); ` +
      `injecting divergence warning into WORKFLOW_STEP.md`,
  );
}

async function writeStepAssets(args: {
  wf: Workflow;
  run: WorkflowRun;
  stepIndex: number;
  backendOrigin: string;
  stepDir: string;
  stepFile: string;
}): Promise<boolean> {
  const { wf, run, stepIndex, backendOrigin, stepDir, stepFile } = args;
  // Best-effort working-tree-drift probe — if the project repo has
  // uncommitted changes, the rendered WORKFLOW_STEP.md gets a warning
  // banner so the planner doesn't synthesize tasks against paths that
  // only exist on disk (worktrees check out HEAD, not the working tree).
  // Probe failures resolve to `null` and just suppress the banner.
  const dirtyState = await getProjectDirtyState(wf.projectPath);
  if (dirtyState) logDirtyState(run, stepIndex, dirtyState);

  // Pre-run tools (an Opengrep scan, …) write their report files into the step
  // dir and contribute the `{{tool_reports}}` block. A tool failure never fails
  // the step — see stepTools.ts.
  const step = wf.steps[stepIndex];
  if (step.tools?.length) {
    console.log(
      `[workflow-step] ${run.id} step ${stepIndex}: running pre-run tools (${step.tools.join(', ')})`,
    );
    // An Opengrep scan can take minutes, during which the run has no terminal
    // yet and the strip would just say "Step N of M". Surface the wait the
    // same way control steps do; the frontend drops it on `step-spawned`.
    notify({
      type: 'step-control-progress',
      runId: run.id,
      projectPath: run.projectPath,
      stepIndex,
      kind: 'agent',
      current: 0,
      total: 0,
      message: `running ${step.tools.map((t) => (t === 'opengrep' ? 'the Opengrep scan' : t)).join(', ')} before the agent starts…`,
    });
  }
  const signal = beginStepPreRun(run.id);
  let tools: Awaited<ReturnType<typeof runStepTools>>;
  try {
    tools = await runStepTools(step, wf.projectPath, stepDir, {}, signal);
  } finally {
    endStepPreRun(run.id, signal);
  }
  // A cancel (or a completed step racing a re-dispatch) during the pre-run:
  // the brief would be for a step nobody will spawn. Stop here; the spawn
  // guard below would skip it anyway.
  if (run.status !== 'running' || run.currentStepIndex !== stepIndex) {
    console.log(`[workflow-step] ${run.id} step ${stepIndex}: run is ${run.status}; not writing the brief`);
    return false;
  }

  const stepTemplate = await resolveInstructionTemplate(wf.projectPath, 'workflow-step');
  await fs.writeFile(
    stepFile,
    renderStepMarkdown(wf, run, stepIndex, backendOrigin, dirtyState, stepTemplate, tools.markdown),
    'utf8',
  );

  // Helper script so the agent can create tasks without shell quoting issues.
  await fs.writeFile(
    path.join(stepDir, 'create-task.cjs'),
    renderHelperScript(wf.projectPath, backendOrigin),
    'utf8',
  );
  return true;
}

async function installStepCallbacks(args: {
  wf: Workflow;
  run: WorkflowRun;
  stepIndex: number;
  backendOrigin: string;
  stepDir: string;
  harness: WorkflowStepHarness;
}): Promise<void> {
  const { wf, run, stepIndex, backendOrigin, stepDir, harness } = args;
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
  // Codex Stop hook (the Codex analogue). Fires once at turn completion and
  // advances the step even if the model forgets to curl — this is what stops a
  // Codex workflow step from lingering/overlapping the next one. The step cwd is
  // fresh scratch under <project>/.lattice/ (gitignored), so 'always' is safe
  // and no extra exclude is needed.
  await installCodexStopHook(
    stepDir,
    `${completionUrl}?source=codex-stop-hook-workflow-step-complete`,
    'always',
  );
  // pi-subagents loader shim alongside the completion extension (no-op until
  // the shared install resolves). Step dir is under <project>/.lattice/, which
  // is gitignored, so no extra exclude is needed.
  await installPiSubagentsShim({ dir: stepDir });
  console.log(
    `[workflow-step] installed Claude+Pi+Codex backstops for run ${run.id} step ${stepIndex} ` +
      `(active harness=${harness}, dir=${stepDir})`,
  );
}

function spawnStepSession(args: {
  wf: Workflow;
  run: WorkflowRun;
  stepIndex: number;
  stepDir: string;
  stepFile: string;
  harness: WorkflowStepHarness;
  codexYolo?: boolean;
}): string {
  const { wf, run, stepIndex, stepDir, stepFile, harness, codexYolo } = args;
  const command = buildWorkflowStepCommand(
    stepFile,
    harness,
    effectiveStepPiModel(wf, run, stepIndex),
    codexYolo,
  );

  if (run.status === 'running' && run.currentStepIndex === stepIndex) {
    enqueueWorkflowStepSession({
      run,
      stepIndex,
      projectPath: wf.projectPath,
      stepDir,
      command,
      harness,
    });
  }

  return command;
}

export async function spawnWorkflowStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<{ command: string; cwd: string }> {
  const { stepDir, stepFile } = await prepareStepScratch(wf, run, stepIndex);
  const harness = effectiveStepHarness(wf, run, stepIndex);

  const live = await writeStepAssets({ wf, run, stepIndex, backendOrigin, stepDir, stepFile });
  if (!live) {
    // Cancelled during the pre-run: no callbacks, no pty, no progress event.
    return { command: '', cwd: stepDir };
  }
  await installStepCallbacks({ wf, run, stepIndex, backendOrigin, stepDir, harness });
  // Resolve the Codex `--yolo` toggle only for a Codex step (default ON).
  const codexYolo =
    harness === 'codex' ? await isCodexYoloEnabled(wf.projectPath) : undefined;
  const command = spawnStepSession({
    wf,
    run,
    stepIndex,
    stepDir,
    stepFile,
    harness,
    codexYolo,
  });

  // Emit progress now — the step is the run's current step whether its pty
  // is spawning immediately or waiting in the queue. If cancellation raced
  // with scratch setup, do not resurrect/update the cancelled run.
  if (run.status === 'running' && run.currentStepIndex === stepIndex) {
    notify({ type: 'progress', run: snapshot(run) });
  }

  return { command, cwd: stepDir };
}
