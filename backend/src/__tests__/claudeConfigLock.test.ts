import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withClaudeConfigLock } from '../claudeTrust/configLock.js';
import { withTempDir } from './helpers/tempDir.js';

const FAST = { retryDelays: [1, 1], stealRetryDelays: [1, 1], operationRetryDelays: [1, 1] };
const deadPid = 777777;
const owner = (extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, pid: deadPid, hostname: os.hostname(), acquiredAt: 1, ownerId: randomUUID(), ...extra,
});
const alive = (pid: number) => pid !== deadPid;
const denied = (code = 'EPERM', operation = 'open', lock = 'fixture') =>
  Object.assign(new Error(`${code}: operation not permitted, ${operation} '${lock}'`), { code, path: lock, syscall: operation });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('new owner uses the exact legacy lock path and legacy mkdir/rmdir cannot steal it', async () => {
  await withTempDir('lattice-config-file-lock-', async (dir) => {
    const lock = path.join(dir, 'lock');
    assert.equal(await withClaudeConfigLock(async () => {
      assert.equal((await fs.lstat(lock)).isFile(), true);
      const raw = await fs.readFile(lock, 'utf8');
      assert.equal(JSON.parse(raw).pid, process.pid);
      await assert.rejects(fs.mkdir(lock), { code: 'EEXIST' });
      // Windows can report ENOENT for rmdir(file); only rejection + retained
      // ownership matter, not the platform-specific error spelling.
      await assert.rejects(fs.rmdir(lock));
      assert.equal(await fs.readFile(lock, 'utf8'), raw);
      return 'protected';
    }, { lockDir: lock, ...FAST }), 'protected');
    assert.deepEqual(await fs.readdir(dir), [], 'ordinary writes must not leave retirement tombstones');
  });
});

test('a slow live owner remains exclusive beyond the full contender retry window', async () => {
  await withTempDir('lattice-config-live-lock-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = withClaudeConfigLock(async () => { entered.resolve(); await release.promise; }, { lockDir: lock, ...FAST });
    await entered.promise;
    const raw = await fs.readFile(lock, 'utf8');
    try {
      await assert.rejects(withClaudeConfigLock(async () => assert.fail('overlapping writer'), { lockDir: lock, ...FAST }), /live or cannot be verified dead/);
      assert.equal(await fs.readFile(lock, 'utf8'), raw);
    } finally { release.resolve(); await first; }
  });
});

test('transient Windows acquisition denial retries EPERM/EACCES/EBUSY before entering once', async (t) => {
  await withTempDir('lattice-config-lock-retry-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const open = fs.open;
    let opens = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === lock && opens++ < 3) throw denied(['EPERM', 'EACCES', 'EBUSY'][opens - 1], 'open', lock);
      return open(...args);
    });
    let calls = 0;
    await withClaudeConfigLock(async () => { calls++; }, { lockDir: lock, ...FAST, retryDelays: [1, 1, 1] });
    assert.equal(calls, 1);
    assert.equal(opens, 4);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('persistent acquisition denial preserves original EPERM operation and path without running unlocked', async (t) => {
  await withTempDir('lattice-config-lock-denied-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const open = fs.open;
    const error = denied('EPERM', 'open', lock);
    let attempts = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === lock) { attempts++; throw error; }
      return open(...args);
    });
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('unlocked write'), { lockDir: lock, ...FAST }), (e) => e === error);
    assert.equal(attempts, 6);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('post-open owner initialization denial preserves its original error and incomplete file', async (t) => {
  await withTempDir('lattice-config-lock-init-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const open = fs.open;
    const error = denied('EPERM', 'write', lock);
    let opens = 0;
    let writes = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === lock) {
        opens++;
        t.mock.method(handle, 'write', async () => { writes++; throw error; });
      }
      return handle;
    });
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('incomplete ownership'), { lockDir: lock, ...FAST }), (e) => e === error);
    assert.equal(opens, 1, 'initialization failure must not retry acquisition against its own file');
    assert.equal(writes, 3);
    assert.equal(await fs.readFile(lock, 'utf8'), '');
  });
});

test('same-host provably dead owner is retired exactly once before a new owner enters', async () => {
  await withTempDir('lattice-config-lock-dead-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const raw = owner();
    await fs.writeFile(lock, raw);
    await withClaudeConfigLock(async () => {
      const current = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.equal(current.pid, process.pid);
      assert.notEqual(current.ownerId, JSON.parse(raw).ownerId);
    }, { lockDir: lock, ...FAST, isPidAlive: alive });
    const claims = await fs.readdir(`${lock}.retired`);
    assert.deepEqual(claims, [createHash('sha256').update(raw).digest('hex')]);
    await assert.rejects(fs.lstat(lock), { code: 'ENOENT' });
  });
});

test('foreign and incomplete owners are preserved without retirement', async () => {
  await withTempDir('lattice-config-lock-unknown-', async (dir) => {
    const variants = ['', '{"version":1', owner({ hostname: `${os.hostname()}-other` }), owner({ version: 9 })];
    for (let i = 0; i < variants.length; i++) {
      const lock = path.join(dir, `lock-${i}`);
      await fs.writeFile(lock, variants[i]);
      await assert.rejects(withClaudeConfigLock(async () => assert.fail('unknown owner write'), { lockDir: lock, ...FAST, isPidAlive: () => false }), /could not acquire/);
      assert.equal(await fs.readFile(lock, 'utf8'), variants[i]);
      await assert.rejects(fs.lstat(`${lock}.retired`), { code: 'ENOENT' });
    }
  });
});

test('permission-denied PID probe is not evidence that an owner died', async (t) => {
  await withTempDir('lattice-config-lock-pid-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const raw = owner();
    await fs.writeFile(lock, raw);
    t.mock.method(process, 'kill', () => { throw denied('EPERM', 'kill', String(deadPid)); });
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('unverified dead PID'), { lockDir: lock, ...FAST }), /cannot be verified dead/);
    assert.equal(await fs.readFile(lock, 'utf8'), raw);
  });
});

test('unreadable owner metadata preserves the lock and the filesystem error', async (t) => {
  await withTempDir('lattice-config-lock-unreadable-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const raw = owner();
    await fs.writeFile(lock, raw);
    const read = fs.readFile;
    const error = denied('EACCES', 'read', lock);
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === lock) throw error;
      return read(...args);
    });
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('unreadable owner'), { lockDir: lock, ...FAST, isPidAlive: () => false }), (e) => e === error);
    assert.equal(await read(lock, 'utf8'), raw);
  });
});

test('a delayed stale claimant cannot unlink a replacement live owner', async (t) => {
  await withTempDir('lattice-config-lock-stale-race-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const stale = owner();
    const claim = path.join(`${lock}.retired`, createHash('sha256').update(stale).digest('hex'));
    await fs.writeFile(lock, stale);
    const observed = deferred<void>();
    const resumeOld = deferred<void>();
    const winnerEntered = deferred<void>();
    const releaseWinner = deferred<void>();
    const open = fs.open;
    let claims = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === claim && claims++ === 0) { observed.resolve(); await resumeOld.promise; }
      return open(...args);
    });
    const first = withClaudeConfigLock(async () => assert.fail('stale observer entered'), { lockDir: lock, ...FAST, isPidAlive: alive });
    const firstRejected = assert.rejects(first, /retirement is already claimed|ownership changed/);
    await observed.promise;
    const winner = withClaudeConfigLock(async () => { winnerEntered.resolve(); await releaseWinner.promise; }, { lockDir: lock, ...FAST, isPidAlive: alive });
    await winnerEntered.promise;
    const current = await fs.readFile(lock, 'utf8');
    try {
      resumeOld.resolve();
      await firstRejected;
      assert.equal(await fs.readFile(lock, 'utf8'), current);
    } finally { releaseWinner.resolve(); await winner; }
  });
});

test('live-owner release retries transient unlink denial and leaves no routine tombstone', async (t) => {
  await withTempDir('lattice-config-lock-release-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const unlink = fs.unlink;
    let attempts = 0;
    t.mock.method(fs, 'unlink', async (file: string) => {
      if (file === lock && attempts++ < 2) throw denied('EPERM', 'unlink', lock);
      return unlink(file);
    });
    await withClaudeConfigLock(async () => {}, { lockDir: lock, ...FAST });
    assert.equal(attempts, 3);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('release refuses an observable replacement owner', async () => {
  await withTempDir('lattice-config-lock-replaced-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const replacement = owner({ pid: process.pid });
    await assert.rejects(withClaudeConfigLock(async () => {
      await fs.writeFile(lock, replacement); // simulate an external path replacement
    }, { lockDir: lock, ...FAST }), /release refused/);
    assert.equal(await fs.readFile(lock, 'utf8'), replacement);
  });
});

test('a later acquisition safely retries a finished live owner after release permission recovers', async (t) => {
  await withTempDir('lattice-config-lock-release-recovery-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const unlink = fs.unlink;
    const error = denied('EPERM', 'unlink', lock);
    let blocked = true;
    const cleanupEntered = deferred<void>();
    const finishCleanup = deferred<void>();
    let cleanupCalls = 0;
    t.mock.method(fs, 'unlink', async (file: string) => {
      if (file === lock) {
        if (blocked) throw error;
        if (++cleanupCalls === 1) { cleanupEntered.resolve(); await finishCleanup.promise; }
      }
      return unlink(file);
    });
    await assert.rejects(withClaudeConfigLock(async () => {}, { lockDir: lock, ...FAST }), (e) => e === error);
    const old = await fs.readFile(lock, 'utf8');
    blocked = false;
    let active = 0;
    let peak = 0;
    let entries = 0;
    const write = async () => {
      entries++;
      peak = Math.max(peak, ++active);
      assert.notEqual(await fs.readFile(lock, 'utf8'), old);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    };
    const first = withClaudeConfigLock(write, { lockDir: lock, ...FAST, retryDelays: [5, 5, 5] });
    await cleanupEntered.promise;
    const second = withClaudeConfigLock(write, { lockDir: lock, ...FAST, retryDelays: [5, 5, 5] });
    finishCleanup.resolve();
    await Promise.all([first, second]);
    assert.equal(entries, 2);
    assert.equal(peak, 1);
    assert.equal(cleanupCalls, 3, 'one shared failed-owner cleanup plus each new owner release');
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('failed dead-owner unlink preserves its generation claim and refuses uncertain repeated retirement', async (t) => {
  await withTempDir('lattice-config-lock-retire-denied-', async (dir) => {
    const lock = path.join(dir, 'lock');
    const raw = owner();
    await fs.writeFile(lock, raw);
    const unlink = fs.unlink;
    const error = denied('EPERM', 'unlink', lock);
    const failure = t.mock.method(fs, 'unlink', async (file: string) => {
      if (file === lock) throw error;
      return unlink(file);
    });
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('denied retirement'), { lockDir: lock, ...FAST, isPidAlive: alive }), (e) => e === error);
    failure.mock.restore();
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('uncertain retirement'), { lockDir: lock, ...FAST, isPidAlive: alive }), /retirement is already claimed/);
    assert.equal(await fs.readFile(lock, 'utf8'), raw);
  });
});

test('a symlink at the mutex path is preserved without touching its target', async () => {
  await withTempDir('lattice-config-lock-link-', async (dir) => {
    const target = path.join(dir, 'target');
    const lock = path.join(dir, 'lock');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'untouched');
    await fs.symlink(target, lock, 'junction');
    await assert.rejects(withClaudeConfigLock(async () => assert.fail('symlink owner'), { lockDir: lock, ...FAST, isPidAlive: () => false }), /not a regular file/);
    assert.equal((await fs.lstat(lock)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'untouched');
  });
});

// ── Legacy directory owners ────────────────────────────────────────────────
// Older writers lock by mkdir-ing the SAME path. A directory there carries no
// PID/owner record, so neither elapsed time nor its contents can prove its
// writer died: it may be an orphan or a slow live legacy holder. New writers
// therefore treat it as authoritative — they never run fn() unlocked and never
// remove it (no rmdir "steal"); they only acquire once its owner releases it.

for (const [label, marker] of [['an empty', null], ['a marker-holding', 'held-by-another-caller']] as const) {
  test(`${label} legacy lock directory is preserved and fn never runs`, async () => {
    await withTempDir('lattice-config-lock-legacy-', async (dir) => {
      const lock = path.join(dir, 'lock');
      await fs.mkdir(lock);
      const markerPath = path.join(lock, 'holder.marker');
      if (marker !== null) await fs.writeFile(markerPath, marker);
      let ran = false;
      await assert.rejects(withClaudeConfigLock(async () => { ran = true; }, { lockDir: lock, ...FAST }),
        /could not acquire .*legacy directory has no verifiable owner\. The lock was preserved\./);
      assert.equal(ran, false);
      assert.equal((await fs.lstat(lock)).isDirectory(), true);
      assert.deepEqual(await fs.readdir(lock), marker === null ? [] : ['holder.marker']);
      if (marker !== null) assert.equal(await fs.readFile(markerPath, 'utf8'), marker);
      await assert.rejects(fs.lstat(`${lock}.retired`), { code: 'ENOENT' });
    });
  });
}

test('a contended lock that frees up is acquired without stealing', async () => {
  await withTempDir('lattice-config-lock-contended-', async (dir) => {
    const lock = path.join(dir, 'lock');
    // A legacy directory holder that releases (its own rmdir) well inside the
    // normal contention backoff.
    await fs.mkdir(lock);
    const release = (async () => {
      await new Promise((r) => setTimeout(r, 2));
      await fs.rmdir(lock);
    })();

    let ran = false;
    const result = await withClaudeConfigLock(
      async () => {
        ran = true;
        return 'ok';
      },
      // Generous backoff so the owner file is claimed on the ordinary retry
      // pass once the holder has released — nothing is inspected or retired.
      { lockDir: lock, retryDelays: [5, 5, 5, 5, 5, 5], stealRetryDelays: [1, 1] },
    );
    await release;
    assert.equal(ran, true);
    assert.equal(result, 'ok');
    // Release unlinked our owner file, leaving the path free.
    await assert.rejects(() => fs.stat(lock), { code: 'ENOENT' });
  });
});
