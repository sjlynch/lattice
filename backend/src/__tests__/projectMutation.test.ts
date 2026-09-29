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

for (const rejects of [false, true]) {
  test(`escaped context queues behind a borrower after its originating mutation ${rejects ? 'rejects' : 'succeeds'}`, { timeout: 5_000 }, async (t) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-expired-'));
    const handle = await acquireProjectRunLock(project, 'merge-run');
    const resume = deferred();
    const resumed = deferred();
    const entered = deferred();
    const finish = deferred();
    const pending: Promise<unknown>[] = [];
    const order: string[] = [];
    let owner: ReturnType<typeof currentProjectMutationOwner>;
    let continuation: Promise<string> | undefined;
    t.after(async () => {
      resume.resolve();
      finish.resolve();
      await Promise.allSettled(pending);
      await handle.release();
      await fs.rm(project, { recursive: true, force: true });
    }, { timeout: 2_000 });

    const error = new Error('originating borrower failed');
    const originating = withProjectMutation(project, async () => {
      owner = currentProjectMutationOwner(project);
      assert.equal(owner?.label, 'merge-run');
      // This unawaited continuation inherits the slot's AsyncLocalStorage.
      continuation = (async () => {
        await resume.promise;
        try {
          assert.equal(currentProjectMutationOwner(project), undefined);
          const queued = withProjectMutation(project, async () => {
            order.push('continuation');
            assert.equal(currentProjectMutationOwner(project)?.label, 'merge-run');
            assert.strictEqual(currentProjectMutationOwner(project), owner);
            return 'continuation-result';
          });
          resumed.resolve();
          const result = await queued;
          assert.equal(currentProjectMutationOwner(project), undefined);
          return result;
        } finally {
          resumed.resolve();
        }
      })();
      pending.push(continuation);
      void continuation.catch(() => {});
      if (rejects) throw error;
      return 'originating-result';
    });
    pending.push(originating);
    if (rejects) {
      await assert.rejects(originating, (caught) => {
        assert.strictEqual(caught, error);
        return true;
      });
    } else {
      assert.equal(await originating, 'originating-result');
    }
    assert.ok(continuation);
    assert.ok(owner?.ownerId);

    // Keep this exact registered owner alive: replacement-owner detection
    // cannot fence the expired context for us.
    const borrower = withProjectMutation(project, async () => {
      assert.strictEqual(currentProjectMutationOwner(project), owner);
      order.push('borrower');
      entered.resolve();
      await finish.promise;
      order.push('borrower-done');
    });
    pending.push(borrower);
    void borrower.catch(() => {});
    await entered.promise;
    resume.resolve();
    await resumed.promise;
    assert.deepEqual(order, ['borrower'], 'the expired context must not bypass the active borrower');
    assert.equal((await inspectProjectRunLock(project))?.holder.ownerId, owner.ownerId);
    finish.resolve();
    await borrower;
    assert.equal(await continuation, 'continuation-result');
    assert.deepEqual(order, ['borrower', 'borrower-done', 'continuation']);
    assert.equal((await inspectProjectRunLock(project))?.holder.ownerId, owner.ownerId);
    await handle.release();
    assert.equal(await inspectProjectRunLock(project), null);
  });
}

test('release drains a queued successor after a borrowed mutation rejects', { timeout: 5_000 }, async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-failed-borrower-'));
  const handle = await acquireProjectRunLock(project, 'merge-run');
  const owner = (await inspectProjectRunLock(project))?.holder;
  const entered = deferred();
  const fail = deferred();
  const successorEntered = deferred();
  const finish = deferred();
  const pending: Promise<unknown>[] = [];
  const order: string[] = [];
  let calls = 0;
  let released = false;
  t.after(async () => {
    fail.resolve();
    finish.resolve();
    await Promise.allSettled(pending);
    await handle.release();
    await fs.rm(project, { recursive: true, force: true });
  }, { timeout: 2_000 });
  assert.ok(owner?.ownerId);

  const error = new Error('borrowed mutation failed');
  const failing = withProjectMutation(project, async () => {
    order.push('failing');
    entered.resolve();
    await fail.promise;
    throw error;
  });
  const rejected = assert.rejects(failing, (caught) => {
    assert.strictEqual(caught, error);
    return true;
  });
  pending.push(failing, rejected);
  void rejected.catch(() => {});
  await entered.promise;
  const successor = withProjectMutation(project, async () => {
    calls++;
    order.push('successor');
    assert.equal(currentProjectMutationOwner(project)?.label, 'merge-run');
    assert.equal(currentProjectMutationOwner(project)?.ownerId, owner?.ownerId);
    successorEntered.resolve();
    await finish.promise;
    assert.deepEqual((await inspectProjectRunLock(project))?.holder, owner);
    assert.equal(released, false, 'the lock remains owned through the successor callback');
    order.push('successor-done');
    return 'successor-result';
  });
  pending.push(successor);
  void successor.catch(() => {});
  assert.equal(calls, 0, 'the successor is queued before the borrower fails');
  fail.resolve();
  await rejected;
  await successorEntered.promise;
  const releasing = handle.release().then(() => {
    released = true;
    order.push('released');
  });
  pending.push(releasing);
  void releasing.catch(() => {});
  assert.deepEqual((await inspectProjectRunLock(project))?.holder, owner);
  assert.equal(released, false, 'release must wait for the accepted successor');
  assert.equal(calls, 1);
  assert.deepEqual(order, ['failing', 'successor']);
  finish.resolve();
  assert.equal(await successor, 'successor-result');
  await releasing;
  assert.equal(released, true);
  assert.equal(calls, 1);
  assert.deepEqual(order, ['failing', 'successor', 'successor-done', 'released']);
  assert.equal(await inspectProjectRunLock(project), null);

  const later = await acquireProjectRunLock(project, 'after-failed-borrower');
  try {
    assert.equal((await inspectProjectRunLock(project))?.holder.label, 'after-failed-borrower');
    assert.notEqual((await inspectProjectRunLock(project))?.holder.ownerId, owner?.ownerId);
  } finally {
    await later.release();
  }
  assert.equal(await inspectProjectRunLock(project), null);
});

test('release drains accepted callbacks; a mutation arriving meanwhile waits and then runs on its own lock', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mutation-drain-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const handle = await acquireProjectRunLock(project, 'merge-run');
  const entered = deferred();
  const finish = deferred();
  const order: string[] = [];
  const callback = withProjectMutation(project, async () => {
    entered.resolve();
    await finish.promise;
    await withProjectMutation(project, async () => { order.push('nested'); });
    order.push('callback-done');
  });
  await entered.promise;
  let released = false;
  const releasing = handle.release().then(() => { released = true; });
  // A one-shot Stop-hook `/complete` landing in the closing window used to
  // get an immediate "ownership is closing" throw (→ HTTP 500, waiter never
  // signalled, merge run parked for 30 min). It must now wait the drain out
  // and run afterwards on a freshly acquired owner — never inside the closing
  // one, and never before the accepted borrower finished.
  const late = withProjectMutation(project, async () => {
    order.push('late');
    assert.equal(currentProjectMutationOwner(project)?.label, 'project-mutation');
    return 'ran';
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, [], 'the late mutation does not start while the owner is closing');
  assert.equal(released, false);
  assert.ok(await inspectProjectRunLock(project));
  finish.resolve();
  await Promise.all([callback, releasing]);
  assert.equal(await late, 'ran');
  assert.deepEqual(order, ['nested', 'callback-done', 'late']);
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
