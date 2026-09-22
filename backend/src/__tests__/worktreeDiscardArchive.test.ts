import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../worktree/exec.js';
import { projectGit } from '../worktree/projectGit.js';
import { reconcileStaleState } from '../worktree/reconcile.js';
import { cleanupWorktreeForTask, type WorktreeCleanupDeps } from '../worktree/cleanup.js';
import {
  DISCARDED_WORKTREE_MANIFEST_FILENAME,
  archiveUncommittedWorktreeChanges,
  pruneDiscardedWorktreeArchives,
  readDiscardedWorktreeManifest,
} from '../worktree/discardArchive.js';
import { SNAPSHOTS_BASE, SNAPSHOT_MANIFEST_FILENAME, recoverPendingSnapshots } from '../worktree/snapshot.js';
import { sweepOrphanedWorktrees, type WorktreeSweepDeps } from '../recovery/worktreeSweep.js';
import { homeWorktreesDir, projectHash } from '../projectPath.js';
import type { Task } from '../tasks.js';
import { withTempDir } from './helpers/tempDir.js';

const branch = 'lattice/archive-test';
type Overrides = NonNullable<Parameters<typeof reconcileStaleState>[3]>;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, cwd, { timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout;
}

const COMMIT = ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice-test@example.invalid', '-c', 'commit.gpgsign=false'];

async function withRepo(fn: (repo: string, candidate: string) => Promise<void>): Promise<void> {
  // Writes home-scoped worktrees and snapshots: refuse without the isolated home.
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-discard-archive-', async (root) => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\n');
    await git(repo, ['add', 'tracked.txt']);
    await git(repo, [...COMMIT, 'commit', '-q', '-m', 'initial']);
    const base = homeWorktreesDir(repo);
    await fs.mkdir(base, { recursive: true });
    try {
      await fn(repo, path.join(base, 'archive-test-abc123'));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
      await fs.rm(path.join(SNAPSHOTS_BASE, projectHash(repo)), { recursive: true, force: true });
    }
  });
}

async function archivesFor(repo: string): Promise<string[]> {
  const root = path.join(SNAPSHOTS_BASE, projectHash(repo));
  const names = await fs.readdir(root).catch(() => [] as string[]);
  return names.filter((n) => n.includes('discarded-worktree-')).map((n) => path.join(root, n));
}

const quietDeps: Overrides = {
  killSessions: async () => {},
  waitForHandles: async () => {},
};

test('fresh-run reconcile archives uncommitted worktree edits, then removes the worktree', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'edited in worktree\n');
    await fs.mkdir(path.join(candidate, 'src'));
    await fs.writeFile(path.join(candidate, 'src', 'new.ts'), 'export const x = 1;\n');
    // Lattice-managed files are regenerated per run and are not archived.
    await fs.writeFile(path.join(candidate, 'LATTICE_TASK.md'), '# task\n');
    await fs.mkdir(path.join(candidate, '.claude'));
    await fs.writeFile(path.join(candidate, '.claude', 'settings.local.json'), '{}');

    assert.equal(await reconcileStaleState(repo, branch, candidate, quietDeps), true);
    await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });

    const archives = await archivesFor(repo);
    assert.equal(archives.length, 1);
    const manifest = await readDiscardedWorktreeManifest(archives[0]);
    assert.ok(manifest);
    assert.deepEqual(manifest.modifiedTracked, ['tracked.txt']);
    assert.deepEqual(manifest.untracked, ['src/new.ts']);
    assert.equal(manifest.branch, branch);
    assert.match(path.basename(archives[0]), /discarded-worktree-archive-test-abc123/);
    assert.equal(await fs.readFile(path.join(archives[0], 'files', 'tracked.txt'), 'utf8'), 'edited in worktree\n');
    assert.equal(await fs.readFile(path.join(archives[0], 'files', 'src', 'new.ts'), 'utf8'), 'export const x = 1;\n');
    await assert.rejects(fs.stat(path.join(archives[0], 'files', 'LATTICE_TASK.md')), { code: 'ENOENT' });
    // Not a pending merge snapshot: boot recovery must never restore a
    // worktree's edits into the project checkout.
    await assert.rejects(fs.stat(path.join(archives[0], SNAPSHOT_MANIFEST_FILENAME)), { code: 'ENOENT' });
    await recoverPendingSnapshots();
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'original\n');
    await assert.rejects(fs.stat(path.join(repo, 'src', 'new.ts')), { code: 'ENOENT' });
    assert.ok((await fs.stat(path.join(archives[0], DISCARDED_WORKTREE_MANIFEST_FILENAME))).isFile());
  });
});

test('fresh-run reconcile removes a clean worktree without creating an archive', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'LATTICE_TASK.md'), '# task only\n');
    assert.equal(await reconcileStaleState(repo, branch, candidate, quietDeps), true);
    await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
    assert.deepEqual(await archivesFor(repo), []);
  });
});

test('fresh-run reconcile keeps the worktree and branch when archiving fails', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'precious\n');
    const effects: string[] = [];
    const deps: Overrides = {
      ...quietDeps,
      archiveUncommitted: async () => ({ status: 'failed', error: 'injected copy failure' }),
      projectGit: async (cwd, args, options) => {
        if (args[1] === 'remove' || args[0] === 'branch') effects.push(args.join(' '));
        return projectGit(cwd, args, options);
      },
      pruneReparsePoints: async () => { effects.push('links'); return 0; },
    };
    assert.equal(await reconcileStaleState(repo, branch, candidate, deps), false);
    assert.deepEqual(effects, []);
    assert.equal(await fs.readFile(path.join(candidate, 'tracked.txt'), 'utf8'), 'precious\n');
    await git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  });
});

test('archiving fails closed on a checkout git cannot vouch for', async () => {
  await withRepo(async (repo, candidate) => {
    await fs.mkdir(candidate);
    await fs.writeFile(path.join(candidate, 'orphan.txt'), 'no .git marker');
    const result = await archiveUncommittedWorktreeChanges(repo, candidate, branch);
    assert.equal(result.status, 'failed');
    assert.deepEqual(await archivesFor(repo), []);
  });
});

function sweepDeps(repo: string, removed: string[], overrides: Partial<WorktreeSweepDeps> = {}): WorktreeSweepDeps {
  return {
    forEachKnownProjectSafely: async (_label, fn) => { await fn(repo); },
    listTasks: async () => [{ id: 'historical', status: 'qa' } as Task],
    gitDirExists: async () => true,
    projectGit,
    cleanupWorktreeForTask: async (_repo, dir) => { removed.push(dir); return true; },
    collectLiveSessionCwds: async () => new Set(),
    ...overrides,
  };
}

test('boot sweep archives an orphan\'s uncommitted edits before reclaiming it', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'orphan edit\n');
    const removed: string[] = [];
    await sweepOrphanedWorktrees(sweepDeps(repo, removed));
    assert.deepEqual(removed.map((p) => path.resolve(p).toLowerCase()), [path.resolve(candidate).toLowerCase()]);
    const archives = await archivesFor(repo);
    assert.equal(archives.length, 1);
    assert.equal(await fs.readFile(path.join(archives[0], 'files', 'tracked.txt'), 'utf8'), 'orphan edit\n');
  });
});

test('boot sweep reclaims a clean orphan without an archive, and keeps one it cannot archive', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    const removed: string[] = [];
    await sweepOrphanedWorktrees(sweepDeps(repo, removed));
    assert.equal(removed.length, 1);
    assert.deepEqual(await archivesFor(repo), []);

    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'must survive\n');
    const kept: string[] = [];
    await sweepOrphanedWorktrees(sweepDeps(repo, kept, {
      archiveUncommitted: async () => ({ status: 'failed', error: 'injected' }),
    }));
    assert.deepEqual(kept, []);
    assert.equal(await fs.readFile(path.join(candidate, 'tracked.txt'), 'utf8'), 'must survive\n');
  });
});

test('archive retention keeps the newest N and never touches pending merge snapshots', async () => {
  await withRepo(async (repo) => {
    const root = path.join(SNAPSHOTS_BASE, projectHash(repo));
    await fs.mkdir(root, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const dir = path.join(root, `2026-01-0${i + 1}-discarded-worktree-t${i}-x`);
      await fs.mkdir(path.join(dir, 'files'), { recursive: true });
      await fs.writeFile(path.join(dir, DISCARDED_WORKTREE_MANIFEST_FILENAME), JSON.stringify({
        kind: 'discarded-worktree', version: 1, createdAt: 1000 + i,
      }));
    }
    const pending = path.join(root, '2026-01-01-run-x');
    await fs.mkdir(pending);
    await fs.writeFile(path.join(pending, SNAPSHOT_MANIFEST_FILENAME), '{}');

    assert.equal(await pruneDiscardedWorktreeArchives(repo, 3), 2);
    const left = (await fs.readdir(root)).sort();
    assert.deepEqual(left, [
      '2026-01-01-run-x',
      '2026-01-03-discarded-worktree-t2-x',
      '2026-01-04-discarded-worktree-t3-x',
      '2026-01-05-discarded-worktree-t4-x',
    ]);
  });
});

// ---- cleanupWorktreeForTask (post-merge finalize, task delete, …) ----

function cleanupDeps(extra: Partial<WorktreeCleanupDeps> = {}): WorktreeCleanupDeps {
  return {
    projectGit,
    proxyKillSessionsByCwd: (async () => {}) as unknown as WorktreeCleanupDeps['proxyKillSessionsByCwd'],
    notifySessionsFreed: () => {},
    ...extra,
  };
}

test('cleanupWorktreeForTask archives leftover uncommitted edits before removing the worktree', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'left behind after merge\n');
    await fs.writeFile(path.join(candidate, 'MERGE_INSTRUCTIONS.md'), '# managed, not archived\n');
    assert.equal(await cleanupWorktreeForTask(repo, candidate, branch, cleanupDeps()), true);
    await assert.rejects(fs.stat(candidate), { code: 'ENOENT' });
    const archives = await archivesFor(repo);
    assert.equal(archives.length, 1);
    const manifest = await readDiscardedWorktreeManifest(archives[0]);
    assert.deepEqual(manifest?.modifiedTracked, ['tracked.txt']);
    assert.deepEqual(manifest?.untracked, []);
    assert.equal(
      await fs.readFile(path.join(archives[0], 'files', 'tracked.txt'), 'utf8'),
      'left behind after merge\n',
    );
  });
});

test('cleanupWorktreeForTask takes no archive for a worktree holding only managed files', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'LATTICE_TASK.md'), '# task\n');
    assert.equal(await cleanupWorktreeForTask(repo, candidate, branch, cleanupDeps()), true);
    assert.deepEqual(await archivesFor(repo), []);
  });
});

test('cleanupWorktreeForTask keeps the worktree and branch when the archive fails', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'precious\n');
    const removed = await cleanupWorktreeForTask(repo, candidate, branch, cleanupDeps({
      archiveUncommitted: async () => ({ status: 'failed', error: 'injected copy failure' }),
    }));
    assert.equal(removed, false);
    assert.equal(await fs.readFile(path.join(candidate, 'tracked.txt'), 'utf8'), 'precious\n');
    assert.match(await git(repo, ['branch', '--list', branch]), /archive-test/);
  });
});

test('cleanupWorktreeForTask skipArchive: the caller already archived, so no second archive', async () => {
  await withRepo(async (repo, candidate) => {
    await git(repo, ['worktree', 'add', '-q', '-b', branch, candidate]);
    await fs.writeFile(path.join(candidate, 'tracked.txt'), 'archived by the sweep\n');
    let called = 0;
    const removed = await cleanupWorktreeForTask(repo, candidate, branch, cleanupDeps({
      archiveUncommitted: async () => { called += 1; return { status: 'clean' }; },
    }), { skipArchive: true });
    assert.equal(removed, true);
    assert.equal(called, 0);
  });
});
