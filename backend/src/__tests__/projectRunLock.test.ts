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
import { readLockBody } from '../projectRunLock/lockfile.js';
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
    await writeLock(
      fixture.lockFile,
      holder({ pid: child.pid, label: 'live-holder' }),
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
