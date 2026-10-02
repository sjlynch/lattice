// The Run tests step's start: the skip rule, the start state captured under the
// lock, and the RUN_TESTS.md brief. IO goes through the orchestrator's
// injected `RunTestsDeps`.

import fs from 'node:fs/promises';
import type { Workflow } from '../../workflows.js';
import type { WorkflowRun } from '../state.js';
import { workflowStepDir } from '../scratchDirectory.js';
import { effectiveStepHarness } from '../stepMarkdown.js';
import type { RunTestsState } from './runTestsState.js';
import { renderRecentTasksBlock, selectRecentlyMergedTasks } from './recentTasks.js';
import { renderRunTestsBrief } from './brief.js';
import { writeUserWipFile } from './userWip.js';
import type { ActiveRunTestsStep } from './runTestsLifecycle.js';
import type { RunTestsDeps } from './runTestsStep.js';

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

// The skip rule — a detached HEAD, or HEAD unchanged since the last Run tests.
// `head` is read by the worker (it re-checks the run after). Returns the skip
// note, or the run-tests.json state the brief needs.
export async function preflightSkipNote(
  deps: RunTestsDeps,
  project: string,
  head: string | null,
): Promise<{ skip: string } | { state: RunTestsState | null }> {
  if (await deps.isDetached(project)) {
    return {
      skip: 'Skipped: the project checkout is on a detached HEAD. Merges fast-forward the checked-out branch, so there is no branch to test and commit fixes on — check out a branch.',
    };
  }
  const state: RunTestsState | null = await deps.readState(project);
  if (head && state?.lastHead === head) {
    return {
      skip: `Skipped: nothing merged since the last Run tests (HEAD ${shortSha(head)}, tested ${new Date(state.lastFinishedAt).toLocaleString()}).`,
    };
  }
  return { state };
}

export type RunTestsStartState = {
  stepDir: string;
  wip: string[] | null;
  userWipFile: string;
};

// Start state, captured under the lock (a merge may have landed while we
// waited for it) — USER_WIP.txt and the `run.testStep` checkpoint.
export async function captureStartState(deps: RunTestsDeps, run: WorkflowRun, stepIndex: number): Promise<RunTestsStartState> {
  const project = run.projectPath;
  const startHead = await deps.readHead(project);
  const wip = await deps.readStatus(project);
  const stepDir = workflowStepDir(project, run.id, stepIndex);
  await fs.mkdir(stepDir, { recursive: true });
  const userWipFile = await writeUserWipFile(stepDir, wip ?? []);
  run.testStep = { stepIndex, startHead };
  await deps.checkpoint(run);
  return { stepDir, wip, userWipFile };
}

// RUN_TESTS.md — the recently-merged-tasks block and the project's `run-tests`
// template.
export async function buildRunTestsBrief(
  deps: RunTestsDeps,
  wf: Workflow,
  entry: ActiveRunTestsStep,
  state: RunTestsState | null,
  start: RunTestsStartState,
): Promise<string> {
  const { run, stepIndex, backendOrigin } = entry;
  const project = run.projectPath;
  const since = state?.lastFinishedAt ?? run.startedAt;
  const tasks = await deps.listTasks(project).catch(() => []);
  const recentTasksBlock = renderRecentTasksBlock(
    selectRecentlyMergedTasks(tasks, since),
    state ? `since the last Run tests finished (${new Date(since).toLocaleString()})` : 'since this workflow run started',
  );
  const harness = effectiveStepHarness(wf, run, stepIndex);
  const template = await deps.resolveTemplate(project, 'run-tests');
  return renderRunTestsBrief(
    {
      harness,
      projectPath: project,
      stepDir: start.stepDir,
      stepIndex,
      totalSteps: wf.steps.length,
      completeUrl: `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`,
      timeoutMinutes: Math.round(entry.timeoutMs / deps.minuteMs),
      userWipFile: start.userWipFile,
      userWipCount: start.wip ? start.wip.length : null,
      recentTasksBlock,
    },
    template,
  );
}
