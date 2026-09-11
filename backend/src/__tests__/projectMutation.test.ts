import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireProjectRunLock, inspectProjectRunLock, withProjectMutation, ProjectRunLockedError } from '../projectRunLock.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import { currentProjectMutationOwner } from '../projectRunLock/mutation.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('resolver mutations borrow a waiting run owner and serialize against snapshot work', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const handle = await acquireProjectRunLock(project, 'merge-run');
  const entered = deferred();
  const restore = deferred();
  const order: string[] = [];
  const snapshot = withProjectMutation(project, async () => {
    order.push('snapshot');
    entered.resolve();
    await restore.promise;
  });
  await entered.promise;
  const callback = withProjectMutation(project, async () => {
    order.push('callback');
    assert.equal(currentProjectMutationOwner(project)?.label, 'merge-run');
    await withProjectMutation(project, async () => { order.push('nested-finalize'); });
  });
  assert.deepEqual(order, ['snapshot']);
  restore.resolve();
  await Promise.all([snapshot, callback]);
  assert.deepEqual(order, ['snapshot', 'callback', 'nested-finalize']);
  assert.equal((await inspectProjectRunLock(project))?.holder.label, 'merge-run');
  await handle.release();
  assert.equal(await inspectProjectRunLock(project), null);
});

test('release drains accepted callbacks and refuses new admissions until finished', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-drain-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const handle = await acquireProjectRunLock(project, 'merge-run');
  const entered = deferred();
  const finish = deferred();
  const callback = withProjectMutation(project, async () => {
    entered.resolve();
    await finish.promise;
    await withProjectMutation(project, async () => {});
  });
  await entered.promise;
  let released = false;
  const releasing = handle.release().then(() => { released = true; });
  await assert.rejects(withProjectMutation(project, async () => assert.fail('must not start')), /ownership is closing/);
  assert.equal(released, false);
  assert.ok(await inspectProjectRunLock(project));
  finish.resolve();
  await Promise.all([callback, releasing]);
  assert.equal(await inspectProjectRunLock(project), null);
});

test('callback cannot borrow another backend\'s project ownership', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-foreign-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const file = projectRunLockFilePath(project);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, hostname: `${os.hostname()}-other`, startedAt: Date.now(), label: 'other-merge' }));
  await assert.rejects(withProjectMutation(project, async () => assert.fail('must not mutate')), ProjectRunLockedError);
});

test('failed mutation releases a short-lived owner and later mutations continue', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-failed-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await assert.rejects(withProjectMutation(project, async () => { throw new Error('mutation failed'); }), /mutation failed/);
  assert.equal(await inspectProjectRunLock(project), null);
  assert.equal(await withProjectMutation(project, async () => 42), 42);
});

test('simultaneous standalone callbacks share admission and both finish', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-admission-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  let executing = 0;
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => withProjectMutation(project, async () => {
    assert.equal(executing++, 0);
    await Promise.resolve();
    assert.equal(--executing, 0);
    return n;
  })));
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await inspectProjectRunLock(project), null);
});
