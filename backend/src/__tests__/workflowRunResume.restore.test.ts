// Regression for: "I ran a workflow, steps 1-4 ran, step 4 was in progress —
// then the workflow status vanished from the navbar and the run stopped."
//
// Root cause: a workflow run lived ONLY in the in-memory `runs` map. The
// backend process is restarted routinely (tsc -w + the dev runner on any
// backend/src change, a crash, a processGuards fail-fast), and `dev.mjs` only
// defers a restart while a per-project run.lock is held — which a workflow
// holds during CONTROL steps and NOT during agent steps. A restart mid-agent-
// step therefore erased the run: /api/workflow-runs/active went empty (the
// vanished chip), and the step's agent — whose pty lives in the DETACHED
// terminal-server and survives the restart — later POSTed /complete into a
// backend that had never heard of the run, where completeWorkflowStep returned
// silently. Every remaining step (Start all open tasks / Merge / Push) never
// ran, with no error surfaced anywhere.
//
// The fix mirrors every running run to
// ~/.lattice/per-project/<hash>/workflow-runs.json and re-adopts it on boot.
//
// This file: the headline behavior — a restored run advances again (and
// restoring is idempotent), while an unresumable one is surfaced as errored
// instead of left hanging. The policy, the mirror and a held Stop across the
// restart are the sibling workflowRunResume.*.test.ts files.
// Shared fixture: helpers/workflowRunResume.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  completeWorkflowStep,
  failWorkflowRun,
  restoreWorkflowRun,
} from '../workflowRuns.js';
import { runs } from '../workflowRuns/state.js';
import {
  flushWorkflowRunPersist,
  loadPersistedWorkflowRuns,
  writeWorkflowRunsNow,
} from '../workflowRuns/persistence.js';
import { createWorkflow } from '../workflows.js';
import { fakeRun } from './helpers/workflowRunResume.js';

test('a step-completion callback for a run this process never knew is a silent no-op', async () => {
  // This is exactly what the stranded workflow hit: the agent finished, its
  // Stop hook POSTed /complete, and the restarted backend had no run to
  // advance. Nothing threw, nothing was logged as an error, and the remaining
  // steps never ran. Encoded here so the no-op stays the *reason* to restore
  // rather than becoming an accepted outcome.
  await completeWorkflowStep('wfrun_never_existed', 3, 'http://127.0.0.1:5184');
  assert.equal(runs.get('wfrun_never_existed'), undefined);
});

test('restoring a persisted run lets its pending completion callback advance the workflow', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfresume-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'Refactor', [
      { id: 's1', title: 'Refactor', prompt: 'a', mode: 'sequential', harness: 'claude' },
      { id: 's2', title: 'Documentation', prompt: 'b', mode: 'sequential', harness: 'claude' },
    ]);
    canonical = wf.projectPath;

    // A previous backend process mirrored this to disk while step 2 (the last
    // step) was running; that process then died.
    const persisted = fakeRun({
      id: 'wfrun_restored',
      workflowId: wf.id,
      workflowName: wf.name,
      projectPath: wf.projectPath,
      totalSteps: 2,
      currentStepIndex: 1,
    });
    await writeWorkflowRunsNow(wf.projectPath, [persisted]);

    // Fresh process: the run is not in memory, so the pending callback is lost.
    assert.equal(runs.get(persisted.id), undefined);
    await completeWorkflowStep(persisted.id, 1, 'http://127.0.0.1:5184');
    assert.equal(runs.get(persisted.id), undefined, 'no run to advance yet');

    // Boot recovery reads the mirror and re-adopts the run...
    const [fromDisk] = await loadPersistedWorkflowRuns(wf.projectPath);
    assert.ok(fromDisk, 'the interrupted run must survive on disk');
    assert.equal(restoreWorkflowRun(fromDisk), true);
    assert.equal(runs.get(persisted.id)?.status, 'running');
    // ...and restoring is idempotent, so a second recovery pass can't clobber
    // the live run with the stale on-disk snapshot.
    assert.equal(restoreWorkflowRun(fromDisk), false);

    // ...so the still-running agent's Stop hook now advances it. Step 1 is the
    // last step, so the run completes rather than spawning anything.
    await completeWorkflowStep(persisted.id, 1, 'http://127.0.0.1:5184');
    assert.equal(runs.get(persisted.id)?.status, 'completed');

    // And a completed run is dropped from the mirror.
    await flushWorkflowRunPersist(wf.projectPath);
    assert.deepEqual(await loadPersistedWorkflowRuns(wf.projectPath), []);
  } finally {
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === canonical) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200)); // let the workflow store flush
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('failWorkflowRun surfaces an unresumable run instead of leaving it hanging', () => {
  const run = fakeRun({ id: 'wfrun_unresumable' });
  try {
    restoreWorkflowRun(run);
    assert.equal(failWorkflowRun(run.id, 'session did not survive'), true);
    const stored = runs.get(run.id);
    assert.equal(stored?.status, 'errored');
    assert.equal(stored?.error, 'session did not survive');
    assert.ok(stored?.finishedAt);
    // Idempotent: a second recovery pass (or a late callback) can't re-error it.
    assert.equal(failWorkflowRun(run.id, 'again'), false);
    assert.equal(runs.get(run.id)?.error, 'session did not survive');
  } finally {
    runs.delete(run.id);
  }
});
