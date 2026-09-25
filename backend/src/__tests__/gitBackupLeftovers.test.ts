import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupProjectGitBundle,
  bundleTimeoutMs,
  LEFTOVER_STALE_MS,
  type GitBackupDeps,
} from '../worktree/gitBackup.js';

// Regression coverage for the leaked `<ts>.bundle.lock`: `git bundle create`
// writes through `<path>.lock`, and a timeout kill (or a backend death)
// skips git's own lockfile cleanup — a multi-GB file per failed run that the
// `.bundle`-only retention never counted or pruned.

const GB = 1024 ** 3;

async function withBackupsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-git-backups-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function deps(dir: string, git: GitBackupDeps['git']): Partial<GitBackupDeps> {
  return {
    backupsDir: () => dir,
    git,
    freeBytesAt: async () => null,
    minFreeBytes: async () => 0,
  };
}

const bundlePathOf = (args: string[]): string => args[args.indexOf('create') + 1];

async function setAge(p: string, ageMs: number): Promise<void> {
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(p, t, t);
}

test('a failed (timed-out) bundle removes the .lock git was writing through', async () => {
  await withBackupsDir(async (dir) => {
    let lockPath = '';
    const git: GitBackupDeps['git'] = async (_repo, args) => {
      const bundlePath = bundlePathOf(args);
      lockPath = `${bundlePath}.lock`;
      await fs.writeFile(lockPath, 'partial pack');
      return { stdout: '', stderr: '\n[exec] killed after 60000ms timeout', code: 124 };
    };
    await assert.rejects(backupProjectGitBundle('C:\\no-such-repo', deps(dir, git)), /exit 124/);
    assert.ok(lockPath.endsWith('.bundle.lock'));
    assert.deepEqual(await fs.readdir(dir), [], 'neither the bundle nor its .lock may survive');
  });
});

test('a thrown git call also removes the partial bundle and its .lock', async () => {
  await withBackupsDir(async (dir) => {
    const git: GitBackupDeps['git'] = async (_repo, args) => {
      const bundlePath = bundlePathOf(args);
      await fs.writeFile(bundlePath, 'x');
      await fs.writeFile(`${bundlePath}.lock`, 'x');
      throw new Error('spawn git ENOENT');
    };
    await assert.rejects(backupProjectGitBundle('C:\\no-such-repo', deps(dir, git)), /ENOENT/);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test('the backup routine sweeps a stale leftover .bundle.lock', async () => {
  await withBackupsDir(async (dir) => {
    const stale = path.join(dir, 'x.bundle.lock');
    await fs.writeFile(stale, 'orphaned pack');
    await setAge(stale, LEFTOVER_STALE_MS + 60_000);

    let written = '';
    const git: GitBackupDeps['git'] = async (_repo, args) => {
      written = bundlePathOf(args);
      await fs.writeFile(written, 'bundle');
      return { stdout: '', stderr: '', code: 0 };
    };
    assert.equal(await backupProjectGitBundle('C:\\no-such-repo', deps(dir, git)), written);
    assert.deepEqual(await fs.readdir(dir), [path.basename(written)]);
  });
});

test('a stale leftover is swept even when the newest bundle is reused', async () => {
  await withBackupsDir(async (dir) => {
    await fs.writeFile(path.join(dir, '2026-09-25T00-00-00-000Z.bundle'), 'recent');
    const stale = path.join(dir, '2026-09-24T00-00-00-000Z.bundle.lock');
    await fs.writeFile(stale, 'orphaned pack');
    await setAge(stale, LEFTOVER_STALE_MS + 60_000);
    const git: GitBackupDeps['git'] = async () => assert.fail('a fresh bundle must be reused');
    assert.equal(await backupProjectGitBundle('C:\\no-such-repo', deps(dir, git)), null);
    assert.deepEqual(await fs.readdir(dir), ['2026-09-25T00-00-00-000Z.bundle']);
  });
});

test('a young leftover is kept but counts toward the byte budget', async () => {
  await withBackupsDir(async (dir) => {
    // Scaled down: 1 KB bundles and an 8 KB budget stand in for GB-sized ones.
    const KB = 1024;
    const names = ['2026-09-20T00-00-00-000Z.bundle', '2026-09-21T00-00-00-000Z.bundle', '2026-09-22T00-00-00-000Z.bundle'];
    for (const name of names) {
      const p = path.join(dir, name);
      await fs.writeFile(p, Buffer.alloc(KB));
      await setAge(p, 60 * 60_000);
    }
    // A fresh 6 KB `.lock` (a bundle still being written by an orphaned
    // pack-objects, or one killed moments ago): not provably dead, so kept.
    const young = path.join(dir, '2026-09-23T00-00-00-000Z.bundle.lock');
    await fs.writeFile(young, Buffer.alloc(6 * KB));

    let written = '';
    const git: GitBackupDeps['git'] = async (_repo, args) => {
      written = bundlePathOf(args);
      await fs.writeFile(written, Buffer.alloc(KB));
      return { stdout: '', stderr: '', code: 0 };
    };
    await backupProjectGitBundle('C:\\no-such-repo', { ...deps(dir, git), maxBytesPerProject: 8 * KB });
    // 8 KB budget − 6 KB leftover − 1 KB expected new bundle: only the newest
    // old bundle may stay beside the new one (without the leftover counted,
    // all three would).
    assert.deepEqual(
      (await fs.readdir(dir)).sort(),
      [names[2], path.basename(young), path.basename(written)].sort(),
    );
  });
});

test('the bundle timeout scales with repo size, capped', () => {
  assert.equal(bundleTimeoutMs(0), 60_000);
  assert.ok(bundleTimeoutMs(4.2 * GB) > 4 * 60_000);
  assert.equal(bundleTimeoutMs(1000 * GB), 20 * 60_000);
  assert.ok(LEFTOVER_STALE_MS > bundleTimeoutMs(1000 * GB));
});
