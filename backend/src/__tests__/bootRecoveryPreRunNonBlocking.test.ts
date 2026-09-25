import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { createTask } from '../tasks.js';
import { cancelWorkflowRun } from '../workflowRuns.js';
import { runs, type WorkflowRun } from '../workflowRuns/state.js';
import { flushWorkflowRunPersist, writeWorkflowRunsNow } from '../workflowRuns/persistence.js';
import { setStepToolsDepsForTest } from '../workflowRuns/stepTools.js';
import { resumeInterruptedWorkflowRuns } from '../recovery/workflowRunResume.js';
import { runBootRecoveryChain } from '../server/startup.js';

// Regression: a restart while an agent step sat in `stepPhase: 'pending'` —
// most likely inside its Opengrep pre-run, which can take minutes — made boot
// recovery await the re-dispatch's whole scan. Until it finished, NO project's
// callback outbox was replayed and interrupted merge runs / owed post-merge
// hooks did not resume. The chain must wait only for the run's re-registration
// and dispatch decision, not for the step's pre-run work.

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

test('a pending agent step stuck in its pre-run does not hold up the rest of the boot recovery chain', async (t) => {
  if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
    t.skip('needs the isolated test home (run through `npm test`)');
    return;
  }
  const project = canonicalProjectPath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-boot-prerun-')));
  // Makes the project "known" so the boot sweep visits it.
  await createTask(project, 'known project marker');

  const runId = `wfrun_boot_prerun_${Date.now()}`;
  const persisted: WorkflowRun = {
    id: runId, workflowId: 'wf-boot-prerun', workflowName: 'Security review', projectPath: project,
    status: 'running', startedAt: Date.now(), currentStepIndex: 0, totalSteps: 1, stepPhase: 'pending',
    definition: { id: 'wf-boot-prerun', name: 'Security review', projectPath: project, createdAt: 1, variables: [], steps: [
      { id: 'scan-step', title: 'Triage', prompt: 'triage the findings', mode: 'sequential', harness: 'claude', tools: ['opengrep'] },
    ] },
  };
  await writeWorkflowRunsNow(project, [persisted]);

  // The pre-run never finishes on its own; only a cancel (cleanup) unwinds it.
  let scanStarted = false;
  const restoreTools = setStepToolsDepsForTest({
    scan: (_project: string, opts?: { signal?: AbortSignal }) => {
      scanStarted = true;
      return new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  let mergeResumed = false;
  let outboxStarted = false;
  let hooksFired = false;
  try {
    const chain = runBootRecoveryChain('http://127.0.0.1:1', () => {}, {
      resumeWorkflowRuns: resumeInterruptedWorkflowRuns,
      resumeMergeRuns: async () => { mergeResumed = true; },
      fireOwedHooks: async () => { hooksFired = true; },
      startOutbox: () => { outboxStarted = true; },
    });
    assert.ok(await waitFor(() => outboxStarted, 10_000), 'callback outbox replay started while the pre-run is still running');
    await chain;
    assert.equal(scanStarted, true, 'the re-dispatched step reached its pre-run');
    assert.equal(mergeResumed, true, 'merge-run resume was not held behind the pre-run');
    assert.equal(hooksFired, true, 'owed post-merge hooks were not held behind the pre-run');
    const live = runs.get(runId);
    assert.equal(live?.status, 'running', 'the run is still registered and running');
    assert.equal(live?.stepPhase, 'pending', 'its step is still inside the pre-run');
  } finally {
    cancelWorkflowRun(runId);
    // Let the aborted pre-run unwind before tearing its scratch down.
    await new Promise((r) => setTimeout(r, 100));
    restoreTools();
    runs.delete(runId);
    await flushWorkflowRunPersist(project);
    await writeWorkflowRunsNow(project, []);
    await fs.rm(project, { recursive: true, force: true }).catch(() => {});
  }
});
