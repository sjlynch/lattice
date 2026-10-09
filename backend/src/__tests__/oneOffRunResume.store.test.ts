// The one-off run store itself (homeScratch/persistence.ts). Every push / QA /
// post-merge-hook mirror goes through createOneOffRunStore. Its write chain is
// the reason the module exists: a slow "running" write landing after a newer
// removal would resurrect a finished run as `running` on the next boot (a
// re-adopted push pushes twice, a finished QA run is re-attached). These pin
// ordering, same-tick coalescing, a throwing collect that must not poison the
// chain, tolerant load() of missing / corrupt / legacy files, and per-project
// chains. Shared fixtures: helpers/oneOffRunResume.ts.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createOneOffRunStore,
  ONE_OFF_RUNS_FILE_VERSION,
  type OneOffRunStore,
} from '../homeScratch/persistence.js';
import { exists, mkProject } from './helpers/oneOffRunResume.js';

type TestRun = { id: string; status: 'running' };

function deserializeTestRun(raw: unknown): TestRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.id === 'string' && r.status === 'running' ? { id: r.id, status: 'running' } : null;
}

function mkTestStore() {
  return createOneOffRunStore<TestRun>({
    fileName: 'test-runs.json',
    logLabel: '[test]',
    deserialize: deserializeTestRun,
  });
}

const running = (id: string): TestRun => ({ id, status: 'running' });

async function readMirror(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Yield microtasks until `cond` holds — lets a queued write START (its
// `collect` runs) while its fs work is still in flight.
async function untilMicrotask(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await Promise.resolve();
  assert.ok(cond(), 'the queued write never started');
}

async function withStoreProject(fn: (project: string, store: OneOffRunStore<TestRun>) => Promise<void>): Promise<void> {
  const project = await mkProject();
  const store = mkTestStore();
  try {
    await fn(project, store);
  } finally {
    await store.flush();
    await fs.rm(store.file(project), { force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
}

test('one-off store ordering: a removal persisted after a running write always wins, and vice versa', async () => {
  await withStoreProject(async (project, store) => {
    // Same tick.
    store.persist(project, () => [running('r1')]);
    store.persist(project, () => []);
    await store.flush(project);
    assert.equal(await exists(store.file(project)), false, 'a finished run must not be resurrected');
    assert.deepEqual(await store.load(project), []);

    store.persist(project, () => []);
    store.persist(project, () => [running('r2')]);
    await store.flush(project);
    assert.deepEqual(await readMirror(store.file(project)), { version: ONE_OFF_RUNS_FILE_VERSION, runs: [running('r2')] });
    assert.deepEqual(await store.load(project), [running('r2')]);

    // The real race: the removal is persisted while the running write is in flight.
    let started = false;
    store.persist(project, () => {
      started = true;
      return [running('r3')];
    });
    await untilMicrotask(() => started);
    store.persist(project, () => []);
    await store.flush(project);
    assert.equal(await exists(store.file(project)), false);
    assert.deepEqual(await store.load(project), []);

    // ...and the reverse: a new running record persisted during a removal lands.
    started = false;
    store.persist(project, () => {
      started = true;
      return [];
    });
    await untilMicrotask(() => started);
    store.persist(project, () => [running('r4')]);
    await store.flush(project);
    assert.deepEqual(await store.load(project), [running('r4')]);
  });
});

test('one-off store coalescing: a same-tick burst runs only the latest collect, once; an in-flight write does not swallow a later persist', async () => {
  await withStoreProject(async (project, store) => {
    const first = mock.fn(() => [running('a')]);
    const second = mock.fn(() => [running('b')]);
    const last = mock.fn(() => [running('c')]);
    store.persist(project, first);
    store.persist(project, second);
    store.persist(project, last);
    await store.flush(project);
    assert.equal(first.mock.callCount(), 0, 'superseded collects are never invoked');
    assert.equal(second.mock.callCount(), 0);
    assert.equal(last.mock.callCount(), 1);
    assert.deepEqual(await store.load(project), [running('c')]);

    // `collect` runs at write START, not at persist time: state changed
    // between persist() and the write is what lands.
    let state: TestRun[] = [running('stale')];
    store.persist(project, () => state);
    state = [running('fresh')];
    await store.flush(project);
    assert.deepEqual(await store.load(project), [running('fresh')]);

    // A persist issued while a write is in flight gets its own, later write.
    const inFlight = mock.fn(() => [running('d')]);
    const after = mock.fn(() => [running('e')]);
    store.persist(project, inFlight);
    await untilMicrotask(() => inFlight.mock.callCount() === 1);
    store.persist(project, after);
    await store.flush(project);
    assert.equal(inFlight.mock.callCount(), 1);
    assert.equal(after.mock.callCount(), 1, 'the persist behind an in-flight write must not be dropped');
    assert.deepEqual(await store.load(project), [running('e')]);
  });
});

test('one-off store: a throwing collect is logged and skipped without poisoning the chain', async () => {
  const errorSpy = mock.method(console, 'error', () => undefined);
  try {
    await withStoreProject(async (project, store) => {
      store.persist(project, () => [running('kept')]);
      await store.flush(project);

      store.persist(project, () => {
        throw new Error('collect boom');
      });
      await store.flush(project);
      assert.ok(
        errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes('[test]') && String(c.arguments[1]).includes('collect boom')),
        'the failure is logged under the store label',
      );
      assert.deepEqual(await store.load(project), [running('kept')], 'a failed collect leaves the mirror untouched');

      store.persist(project, () => [running('next')]);
      await store.flush(project);
      assert.deepEqual(await store.load(project), [running('next')]);

      // Same while the throwing write is still queued behind an in-flight one.
      let started = false;
      store.persist(project, () => {
        started = true;
        return [running('x')];
      });
      await untilMicrotask(() => started);
      store.persist(project, () => {
        throw new Error('collect boom 2');
      });
      await store.flush(project);
      store.persist(project, () => []);
      await store.flush(project);
      assert.equal(await exists(store.file(project)), false);
    });
  } finally {
    errorSpy.mock.restore();
  }
});

test('one-off store load(): missing / corrupt / shapeless files read as []; legacy arrays and valid siblings survive', async () => {
  const errorSpy = mock.method(console, 'error', () => undefined);
  try {
    await withStoreProject(async (project, store) => {
      const file = store.file(project);
      assert.deepEqual(await store.load(project), [], 'missing file');
      await fs.mkdir(path.dirname(file), { recursive: true });

      for (const body of ['{ not json', '', '{"version":1}', '{"version":1,"runs":{"id":"r"}}', 'null', '42', '"runs"']) {
        await fs.writeFile(file, body, 'utf8');
        assert.deepEqual(await store.load(project), [], `body ${JSON.stringify(body)}`);
      }

      // Legacy bare array.
      await fs.writeFile(file, JSON.stringify([running('legacy')]), 'utf8');
      assert.deepEqual(await store.load(project), [running('legacy')]);

      // Records the deserializer rejects are dropped; their siblings are kept.
      await fs.writeFile(file, JSON.stringify({
        version: ONE_OFF_RUNS_FILE_VERSION,
        runs: [running('ok1'), { id: 'finished', status: 'done' }, null, 'junk', { status: 'running' }, running('ok2')],
      }), 'utf8');
      assert.deepEqual(await store.load(project), [running('ok1'), running('ok2')]);
    });
  } finally {
    errorSpy.mock.restore();
  }
});

test('one-off store: writes for two projects interleave without either losing its latest state', async () => {
  const projectA = await mkProject();
  const projectB = await mkProject();
  const store = mkTestStore();
  try {
    assert.notEqual(store.file(projectA), store.file(projectB));
    store.persist(projectA, () => [running('a1')]);
    store.persist(projectB, () => [running('b1')]);
    store.persist(projectA, () => []);
    store.persist(projectB, () => [running('b2')]);
    await store.flush();
    assert.equal(await exists(store.file(projectA)), false);
    assert.deepEqual(await store.load(projectB), [running('b2')]);

    // With both writes in flight, each project's follow-up still lands on its own file.
    let aStarted = false;
    let bStarted = false;
    store.persist(projectA, () => {
      aStarted = true;
      return [running('a2')];
    });
    store.persist(projectB, () => {
      bStarted = true;
      return [];
    });
    await untilMicrotask(() => aStarted && bStarted);
    store.persist(projectB, () => [running('b3')]);
    store.persist(projectA, () => [running('a3'), running('a4')]);
    await store.flush();
    assert.deepEqual(await store.load(projectA), [running('a3'), running('a4')]);
    assert.deepEqual(await store.load(projectB), [running('b3')]);

    // A per-project flush waits for that project's chain.
    store.persist(projectA, () => []);
    await store.flush(projectA);
    assert.equal(await exists(store.file(projectA)), false);
    assert.deepEqual(await store.load(projectB), [running('b3')]);
  } finally {
    await store.flush();
    for (const p of [projectA, projectB]) {
      await fs.rm(store.file(p), { force: true });
      await fs.rm(p, { recursive: true, force: true });
    }
  }
});
