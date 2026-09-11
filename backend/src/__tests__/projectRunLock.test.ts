import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireProjectRunLock,
  inspectProjectRunLock,
  ProjectRunLockedError,
} from '../projectRunLock.js';
import { readLockBody, readLockObservation, retireLockFile } from '../projectRunLock/lockfile.js';
import { clearStaleLockOrThrow } from '../projectRunLock/steal.js';
import { releaseLockFile } from '../projectRunLock/release.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
import type { LockBody } from '../projectRunLock/types.js';

async function createFixture(): Promise<{
  projectPath: string;
  lockFile: string;
  cleanup: () => Promise<void>;
}> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-run-lock-project-'));
  const lockFile = projectRunLockFilePath(projectPath);
  const lockDir = path.dirname(lockFile);
  await fs.rm(lockDir, { recursive: true, force: true });
  await fs.mkdir(lockDir, { recursive: true });
  return {
    projectPath,
    lockFile,
    cleanup: async () => {
      await fs.rm(lockDir, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    },
  };
}

function holder(overrides: Partial<LockBody> = {}): LockBody {
  return {
    pid: -1,
    hostname: os.hostname(),
    startedAt: 1,
    label: 'test-lock',
    ...overrides,
  };
}

async function writeLock(file: string, body: LockBody): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
}

async function expectLocked(fn: () => Promise<unknown>): Promise<ProjectRunLockedError> {
  let locked: ProjectRunLockedError | null = null;
  await assert.rejects(
    fn,
    (err) => {
      assert.ok(err instanceof ProjectRunLockedError);
      locked = err;
      return true;
    },
  );
  assert.ok(locked);
  return locked;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('acquire steals an unparseable lockfile', async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(fixture.lockFile, '{not json', 'utf8');
    assert.equal(await inspectProjectRunLock(fixture.projectPath), null);

    const handle = await acquireProjectRunLock(fixture.projectPath, 'after-unparseable');
    const current = await readLockBody(fixture.lockFile);
    assert.equal(current?.pid, process.pid);
    assert.equal(current?.hostname, os.hostname());
    assert.equal(current?.label, 'after-unparseable');

    await handle.release();
    assert.equal(await readLockBody(fixture.lockFile), null);
  } finally {
    await fixture.cleanup();
  }
});

test('acquire steals a stale same-host lockfile', async () => {
  const fixture = await createFixture();
  try {
    await writeLock(fixture.lockFile, holder({ pid: -123, label: 'stale-holder' }));
    const inspected = await inspectProjectRunLock(fixture.projectPath);
    assert.equal(inspected?.holder.label, 'stale-holder');
    assert.equal(inspected?.alive, false);

    const handle = await acquireProjectRunLock(fixture.projectPath, 'stale-stealer');
    const current = await readLockBody(fixture.lockFile);
    assert.equal(current?.pid, process.pid);
    assert.equal(current?.label, 'stale-stealer');

    await handle.release();
    assert.equal(await readLockBody(fixture.lockFile), null);
  } finally {
    await fixture.cleanup();
  }
});

test('acquire refuses a live same-host holder', async () => {
  const fixture = await createFixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    assert.ok(child.pid);
    // The child was spawned just above, so a lock stamped `now` post-dates
    // the holder's start — a genuine live holder, not a recycled PID.
    await writeLock(
      fixture.lockFile,
      holder({ pid: child.pid, startedAt: Date.now(), label: 'live-holder' }),
    );

    const err = await expectLocked(() =>
      acquireProjectRunLock(fixture.projectPath, 'contender'),
    );
    assert.equal(err.holder.pid, child.pid);
    assert.equal(err.holder.label, 'live-holder');
    assert.equal((await readLockBody(fixture.lockFile))?.label, 'live-holder');
  } finally {
    await stopChild(child);
    await fixture.cleanup();
  }
});

test('acquire steals a lock whose PID was recycled by a younger process', async () => {
  const fixture = await createFixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    assert.ok(child.pid);
    // The PID is alive, but the lock claims to predate this process by a
    // full day — so the PID was recycled and the original holder is long
    // dead. The lock must be stealable (the react-chorus stale-lock bug).
    await writeLock(
      fixture.lockFile,
      holder({
        pid: child.pid,
        startedAt: Date.now() - 24 * 60 * 60 * 1000,
        label: 'recycled-pid-holder',
      }),
    );

    const inspected = await inspectProjectRunLock(fixture.projectPath);
    assert.equal(inspected?.alive, false);

    const handle = await acquireProjectRunLock(fixture.projectPath, 'after-recycle');
    const current = await readLockBody(fixture.lockFile);
    assert.equal(current?.pid, process.pid);
    assert.equal(current?.label, 'after-recycle');

    await handle.release();
    assert.equal(await readLockBody(fixture.lockFile), null);
  } finally {
    await stopChild(child);
    await fixture.cleanup();
  }
});

test('acquire refuses same-process re-entry', async () => {
  const fixture = await createFixture();
  try {
    const handle = await acquireProjectRunLock(fixture.projectPath, 'outer');
    try {
      const err = await expectLocked(() =>
        acquireProjectRunLock(fixture.projectPath, 'inner'),
      );
      assert.equal(err.holder.pid, process.pid);
      assert.equal(err.holder.hostname, os.hostname());
      assert.equal(err.holder.label, 'outer');
    } finally {
      await handle.release();
    }
    assert.equal(await readLockBody(fixture.lockFile), null);
  } finally {
    await fixture.cleanup();
  }
});

test('remote-host locks are conservatively treated as live', async () => {
  const fixture = await createFixture();
  try {
    const remote = holder({
      pid: -123,
      hostname: `${os.hostname()}-remote`,
      label: 'remote-holder',
    });
    await writeLock(fixture.lockFile, remote);

    const inspected = await inspectProjectRunLock(fixture.projectPath);
    assert.equal(inspected?.alive, true);
    const err = await expectLocked(() =>
      acquireProjectRunLock(fixture.projectPath, 'local-contender'),
    );
    assert.equal(err.holder.hostname, remote.hostname);
    assert.deepEqual(await readLockBody(fixture.lockFile), remote);
  } finally {
    await fixture.cleanup();
  }
});

test('release leaves a lockfile that was stolen and recreated', async () => {
  const fixture = await createFixture();
  try {
    const handle = await acquireProjectRunLock(fixture.projectPath, 'original');
    const original = await readLockBody(fixture.lockFile);
    assert.ok(original);

    const replacement = holder({
      pid: original.pid,
      hostname: original.hostname,
      startedAt: original.startedAt + 1,
      label: 'replacement-after-steal',
    });
    await writeLock(fixture.lockFile, replacement);

    await handle.release();
    assert.deepEqual(await readLockBody(fixture.lockFile), replacement);
  } finally {
    await fixture.cleanup();
  }
});

test('a contender cannot steal a lock while its owner is still writing the body', async (t) => {
  const fixture = await createFixture();
  const originalWrite = fs.writeFile;
  let firstOpened!: () => void;
  const opened = new Promise<void>((resolve) => { firstOpened = resolve; });
  let continueWrite!: () => void;
  const proceed = new Promise<void>((resolve) => { continueWrite = resolve; });
  let intercepted = false;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (!intercepted && String(args[0]).startsWith(fixture.lockFile)) {
      intercepted = true;
      const handle = await fs.open(args[0] as string, 'wx');
      firstOpened();
      await proceed;
      assert.equal(typeof args[1], 'string');
      try { await handle.writeFile(args[1] as string, 'utf8'); } finally { await handle.close(); }
      return;
    }
    return originalWrite(...args);
  });
  try {
    const first = acquireProjectRunLock(fixture.projectPath, 'first').then(
      (handle) => ({ handle }), (error: unknown) => ({ error }),
    );
    await opened;
    const second = await acquireProjectRunLock(fixture.projectPath, 'second').then(
      (handle) => ({ handle }), (error: unknown) => ({ error }),
    );
    continueWrite();
    const results = [await first, second];
    const successes = results.filter((result) => 'handle' in result);
    for (const result of successes) if ('handle' in result) await result.handle.release();
    assert.equal(successes.length, 1, 'exactly one caller may enter the protected merge pipeline');
  } finally {
    continueWrite();
    await fixture.cleanup();
  }
});

test('two stale observers cannot retire each other\'s replacement generation', async (t) => {
  const fixture = await createFixture();
  const originalRead = fs.readFile;
  let observed!: () => void;
  const paused = new Promise<void>((r) => { observed = r; });
  let resume!: () => void;
  const proceed = new Promise<void>((r) => { resume = r; });
  let intercepted = false;
  try {
    await writeLock(fixture.lockFile, holder());
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalRead(...args);
      if (!intercepted && String(args[0]) === fixture.lockFile) {
        intercepted = true;
        observed();
        await proceed;
      }
      return result;
    });
    const delayed = clearStaleLockOrThrow(fixture.lockFile).then(() => null, (err: unknown) => err);
    await paused;
    const winner = await acquireProjectRunLock(fixture.projectPath, 'winner');
    const replacement = await readLockBody(fixture.lockFile);
    resume();
    assert.ok(await delayed instanceof Error);
    assert.deepEqual(await readLockBody(fixture.lockFile), replacement);
    await winner.release();
  } finally {
    resume();
    t.mock.restoreAll();
    await fixture.cleanup();
  }
});

test('a delayed release cannot unlink the next owner after another release retires it', async (t) => {
  const fixture = await createFixture();
  const originalRead = fs.readFile;
  let observed!: () => void;
  const paused = new Promise<void>((r) => { observed = r; });
  let resume!: () => void;
  const proceed = new Promise<void>((r) => { resume = r; });
  let intercepted = false;
  try {
    const first = await acquireProjectRunLock(fixture.projectPath, 'first');
    const owner = (await readLockBody(fixture.lockFile))!;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      const result = await originalRead(...args);
      if (!intercepted && String(args[0]) === fixture.lockFile) {
        intercepted = true;
        observed();
        await proceed;
      }
      return result;
    });
    const delayed = releaseLockFile(fixture.lockFile, owner);
    await paused;
    await first.release();
    const second = await acquireProjectRunLock(fixture.projectPath, 'second');
    const replacement = await readLockBody(fixture.lockFile);
    resume();
    await delayed;
    assert.deepEqual(await readLockBody(fixture.lockFile), replacement);
    await second.release();
  } finally {
    resume();
    t.mock.restoreAll();
    await fixture.cleanup();
  }
});

test('an interrupted retirement is refused without removing the uncertain generation', async (t) => {
  const fixture = await createFixture();
  try {
    await writeLock(fixture.lockFile, holder());
    const before = (await readLockObservation(fixture.lockFile))!;
    const originalUnlink = fs.unlink;
    t.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
      if (String(file) === fixture.lockFile) throw Object.assign(new Error('injected crash window'), { code: 'EIO' });
      return originalUnlink(file);
    });
    await assert.rejects(retireLockFile(fixture.lockFile, before), /injected crash/);
    t.mock.restoreAll();
    await assert.rejects(acquireProjectRunLock(fixture.projectPath, 'contender'), /retirement was interrupted/);
    assert.deepEqual(await readLockObservation(fixture.lockFile), before);
  } finally {
    t.mock.restoreAll();
    await fixture.cleanup();
  }
});

test('generations acquired in the same millisecond have distinct identities', async (t) => {
  const fixture = await createFixture();
  try {
    t.mock.method(Date, 'now', () => 12345678900000);
    const first = await acquireProjectRunLock(fixture.projectPath, 'same');
    const a = await readLockBody(fixture.lockFile);
    await first.release();
    const second = await acquireProjectRunLock(fixture.projectPath, 'same');
    const b = await readLockBody(fixture.lockFile);
    assert.ok(a?.ownerId);
    assert.notEqual(a?.ownerId, b?.ownerId);
    await first.release();
    assert.deepEqual(await readLockBody(fixture.lockFile), b);
    await second.release();
  } finally {
    t.mock.restoreAll();
    await fixture.cleanup();
  }
});
