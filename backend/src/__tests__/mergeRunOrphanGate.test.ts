import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { homeProjectDir } from '../projectPath.js';
import { createRunState } from '../mergeRuns/state.js';
import type { MergeRun, MergeRunEvent } from '../mergeRuns/types.js';

// Regressions for the "a merge run is already in progress" wedge (observed on
// C:\development\interview_eci): the project's persisted run record sat at
// `status: 'running', processed: 0` with `cancelRequested: true` LONG after the
// worker had logged `completed — merged=2 conflicts=6 errors=2`. Every later
// merge-all (and the workflow Merge control step) got a 409 forever, and the
// cancel button did nothing.
//
// Cause: `loadProject` re-seeded the run map from the persisted CACHE, whose
// entries are snapshots — so a second startMergeRun landing while a run was in
// flight (a resolver `/complete` restart, a workflow Merge step, a UI click)
// swapped the live run object for a frozen clone. The worker kept mutating the
// original; the map — which the 409 gate and cancel read — kept the clone.

function makeRun(projectPath: string, id: string): MergeRun {
  return {
    id,
    projectPath,
    status: 'running',
    startedAt: Date.now(),
    total: 3,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
}

async function withTempProject(fn: (projectPath: string) => Promise<void>): Promise<void> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mergerun-'));
  try {
    await fn(projectPath);
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
    await fs.rm(homeProjectDir(projectPath), { recursive: true, force: true }).catch(() => {});
  }
}

test('persisted merge-runs are capped to the newest 50 settled runs plus every running one', async () => {
  // merge-runs.json is rewritten on every progress event; unbounded, a
  // long-lived project turned each event into a multi-megabyte write.
  await withTempProject(async (projectPath) => {
    const state = createRunState();
    const key = await state.loadProject(projectPath);
    // The oldest record of all is still running — it must never be dropped.
    const running: MergeRun = { ...makeRun(key, 'run_running_oldest'), startedAt: 1 };
    state.runs.set(running.id, running);
    state.markRunLive(running.id);
    for (let i = 0; i < 60; i += 1) {
      const settled: MergeRun = { ...makeRun(key, `run_${i}`), status: 'completed', startedAt: 100 + i };
      state.runs.set(settled.id, settled);
    }

    state.emit({ type: 'progress', run: { ...running } });
    await state.flushPersist(key);

    const file = path.join(homeProjectDir(key), 'merge-runs.json');
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as MergeRun[];
    const ids = new Set(persisted.map((run) => run.id));
    assert.equal(persisted.length, 51);
    assert.ok(ids.has('run_running_oldest'), 'a running run is always persisted');
    for (let i = 0; i < 10; i += 1) assert.ok(!ids.has(`run_${i}`), `oldest settled run_${i} is dropped`);
    for (let i = 10; i < 60; i += 1) assert.ok(ids.has(`run_${i}`), `run_${i} is kept`);
    assert.equal(state.runs.size, 61, 'the in-memory map is not trimmed');
    assert.equal(state.getRun('run_0')?.status, 'completed');
  });
});

test('loadProject never swaps a live run object for its persisted snapshot', async () => {
  await withTempProject(async (projectPath) => {
    const state = createRunState();
    const key = await state.loadProject(projectPath);

    const run = makeRun(key, 'run_live');
    state.runs.set(run.id, run);
    state.markRunLive(run.id);
    // The 'started' emit is what writes the (processed: 0) snapshot to cache.
    state.emit({ type: 'started', run: { ...run } });

    // A second startMergeRun arriving mid-run loads the project again.
    await state.loadProject(projectPath);

    assert.equal(state.runs.get(run.id), run, 'run map must still hold the LIVE object');

    // Mutations the worker makes after that second load must be visible.
    run.processed = 3;
    run.status = 'completed';
    assert.equal(state.getRun(run.id)?.processed, 3);
    assert.equal(state.getActiveRunForProject(key), null, 'completed run must not gate a new one');
  });
});

test('an orphaned running record is reaped instead of gating forever', async () => {
  await withTempProject(async (projectPath) => {
    const state = createRunState();
    const key = await state.loadProject(projectPath);

    // A `running` record with no worker behind it (never marked live).
    const zombie = makeRun(key, 'run_zombie');
    state.runs.set(zombie.id, zombie);

    const events: MergeRunEvent[] = [];
    state.subscribe((ev) => events.push(ev));

    assert.equal(state.getActiveRunForProject(key), null, 'zombie must not read as active');
    assert.equal(state.runs.get(zombie.id)?.status, 'errored');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'completed');
  });
});

test('a live run is left alone by the reaper', async () => {
  await withTempProject(async (projectPath) => {
    const state = createRunState();
    const key = await state.loadProject(projectPath);

    const run = makeRun(key, 'run_alive');
    state.runs.set(run.id, run);
    state.markRunLive(run.id);

    assert.equal(state.getActiveRunForProject(key)?.id, run.id);
    assert.equal(run.status, 'running');

    // Worker finished (finalize resolved) but left the record running — now
    // reapable.
    state.markRunSettled(run.id);
    assert.equal(state.getActiveRunForProject(key), null);
    assert.equal(run.status, 'errored');
  });
});

test('cancel settles a run no worker can observe', async () => {
  await withTempProject(async (projectPath) => {
    const state = createRunState();
    const key = await state.loadProject(projectPath);

    const stuck = makeRun(key, 'run_stuck');
    state.runs.set(stuck.id, stuck);

    const events: MergeRunEvent[] = [];
    state.subscribe((ev) => events.push(ev));

    assert.equal(state.cancelRun(stuck.id), true);
    assert.equal(stuck.status, 'cancelled', 'cancel must not be a silent no-op');
    assert.equal(stuck.finishedAt !== undefined, true);
    assert.equal(events.at(-1)?.type, 'cancelled');
    assert.equal(state.getActiveRunForProject(key), null);

    // A live run still just gets the cooperative flag — its worker halts.
    const live = makeRun(key, 'run_live_cancel');
    state.runs.set(live.id, live);
    state.markRunLive(live.id);
    assert.equal(state.cancelRun(live.id), true);
    assert.equal(live.status, 'running');
    assert.equal(live.cancelRequested, true);
  });
});
