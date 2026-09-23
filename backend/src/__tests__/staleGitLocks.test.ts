// Abandoned git lock files (2026-09-23): a git killed mid-command — here by a
// disk-full crash — left `.git/index.lock` behind, and a 25-task merge run then
// failed every fast-forward on `Unable to create '…/index.lock': File exists`.
// Pins both halves: a provably abandoned lock is removed (and ONLY then), and a
// lock that is still there halts the run once instead of erroring every task.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_GIT_LOCK_AFTER_MS,
  clearStaleGitLocks,
  defaultStaleGitLockDeps,
  gitLockPathFromError,
  parseEtimeMs,
  type StaleGitLockDeps,
} from '../worktree/staleGitLocks.js';
import { withTempDir } from './helpers/tempDir.js';

const execFileAsync = promisify(execFile);
const PREFIX = 'lattice-stale-git-lock-';
const NOW = 1_800_000_000_000;

function deps(over: Partial<StaleGitLockDeps> & { files: Map<string, number> }): StaleGitLockDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    lockCandidates: async () => [...over.files.keys()],
    mtimeMs: async (f) => over.files.get(f) ?? null,
    gitProcessStartTimes: async () => [],
    unlink: async (f) => {
      removed.push(f);
      over.files.delete(f);
    },
    now: () => NOW,
    ...over,
  };
}

test('an old lock with no git process predating it is removed', async () => {
  const d = deps({ files: new Map([['/r/.git/index.lock', NOW - STALE_GIT_LOCK_AFTER_MS - 1]]) });
  // A git process that started AFTER the lock was written cannot own it.
  d.gitProcessStartTimes = async () => [NOW - 1000];
  const r = await clearStaleGitLocks('/r', d);
  assert.deepEqual(r.cleared, ['/r/.git/index.lock']);
  assert.deepEqual(d.removed, ['/r/.git/index.lock']);
  assert.deepEqual(r.blocking, []);
});

test('a recent lock is left alone — a git command may still be running', async () => {
  const d = deps({ files: new Map([['/r/.git/index.lock', NOW - 30_000]]) });
  const r = await clearStaleGitLocks('/r', d);
  assert.deepEqual(d.removed, []);
  assert.equal(r.blocking[0]?.reason, 'fresh');
});

test('an old lock is kept while a git process older than it is running', async () => {
  const mtime = NOW - STALE_GIT_LOCK_AFTER_MS * 3;
  const d = deps({ files: new Map([['/r/.git/index.lock', mtime]]) });
  d.gitProcessStartTimes = async () => [mtime - 60_000];
  const r = await clearStaleGitLocks('/r', d);
  assert.deepEqual(d.removed, []);
  assert.equal(r.blocking[0]?.reason, 'held');
});

test('an unreadable process start time or a failed listing keeps the lock', async () => {
  const files = () => new Map([['/r/.git/index.lock', NOW - STALE_GIT_LOCK_AFTER_MS * 2]]);
  const unreadable = deps({ files: files() });
  unreadable.gitProcessStartTimes = async () => [NaN];
  assert.equal((await clearStaleGitLocks('/r', unreadable)).blocking[0]?.reason, 'held');
  assert.deepEqual(unreadable.removed, []);

  const unlisted = deps({ files: files() });
  unlisted.gitProcessStartTimes = async () => null;
  assert.equal((await clearStaleGitLocks('/r', unlisted)).blocking[0]?.reason, 'unknown');
  assert.deepEqual(unlisted.removed, []);
});

test('a lock re-created between the scan and the removal is not deleted', async () => {
  const files = new Map([['/r/.git/index.lock', NOW - STALE_GIT_LOCK_AFTER_MS * 2]]);
  const d = deps({ files });
  let reads = 0;
  d.mtimeMs = async (f) => (++reads === 1 ? files.get(f) ?? null : NOW);
  await clearStaleGitLocks('/r', d);
  assert.deepEqual(d.removed, []);
});

test('no lock present: no process listing at all', async () => {
  const d = deps({ files: new Map() });
  d.gitProcessStartTimes = async () => assert.fail('must not list processes when nothing is locked');
  assert.deepEqual(await clearStaleGitLocks('/r', d), { cleared: [], blocking: [] });
});

test('helpers: lock path from git stderr, ps etime parsing', () => {
  assert.equal(
    gitLockPathFromError("error: Unable to create 'C:/development/ody/rewrite/.git/index.lock': File exists."),
    'C:/development/ody/rewrite/.git/index.lock',
  );
  assert.equal(gitLockPathFromError('fatal: Not possible to fast-forward, aborting.'), null);
  assert.equal(parseEtimeMs('05:07'), (5 * 60 + 7) * 1000);
  assert.equal(parseEtimeMs('2:05:07'), ((2 * 60 + 5) * 60 + 7) * 1000);
  assert.equal(parseEtimeMs('1-00:00:01'), (24 * 3600 + 1) * 1000);
  assert.equal(parseEtimeMs('bogus'), null);
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

async function repoWithCommit(repo: string): Promise<void> {
  await git(repo, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
}

test('real repo: the default candidates find index.lock and the branch ref lock', async () => {
  await withTempDir(PREFIX, async (repo) => {
    await repoWithCommit(repo);
    const index = path.join(repo, '.git', 'index.lock');
    const ref = path.join(repo, '.git', 'refs', 'heads', 'main.lock');
    await fs.writeFile(index, '');
    await fs.writeFile(ref, '');
    const old = new Date(Date.now() - STALE_GIT_LOCK_AFTER_MS * 2);
    await fs.utimes(index, old, old);
    await fs.utimes(ref, old, old);
    // Real candidate discovery + fs; the process list is faked (other tests
    // run git concurrently in this process tree).
    const report = await clearStaleGitLocks(repo, { ...defaultStaleGitLockDeps, gitProcessStartTimes: async () => [] });
    const norm = (p: string) => path.resolve(p).toLowerCase();
    assert.deepEqual(report.cleared.map(norm).sort(), [index, ref].map(norm).sort());
    await assert.rejects(fs.access(index));
    // git works again.
    await git(repo, ['update-index', '--refresh']);
  });
});

test('a run whose task failed on a lock that is still there halts once', async () => {
  const { finishTaskAndCheckIntegrity } = await import('../mergeRuns/repoIntegrity.js');
  const { createRunState } = await import('../mergeRuns/state.js');
  await withTempDir(PREFIX, async (repo) => {
    await repoWithCommit(repo);
    const lock = path.join(repo, '.git', 'index.lock');
    await fs.writeFile(lock, ''); // fresh — a git command may be running
    const state = createRunState();
    state.emit = () => {};
    const run = {
      id: 'run-lock', projectPath: repo, status: 'running' as const, startedAt: 1, total: 25,
      processed: 0, merged: [], conflicted: [],
      errored: [{ taskId: 't1', error: `Fast-forward of main to lattice/x failed: error: Unable to create '${lock.replace(/\\/g, '/')}': File exists.` }],
      cancelRequested: false,
    };
    const ctx = { projectPath: repo, backendOrigin: 'http://unused', baselineHead: null as string | null, state };
    const out = await finishTaskAndCheckIntegrity(run, ctx, 't1', { kind: 'errored' });
    assert.equal(out.kind, 'lock-halt');
    assert.equal(run.cancelRequested, true);
    assert.match(run.errored.at(-1)?.error ?? '', /locked by git: .*index\.lock.*24 task\(s\) stay Ready to Merge/s);

    // Once the lock is gone, the same error on the next task does not halt.
    await fs.rm(lock);
    const run2 = { ...run, errored: [...run.errored.slice(0, 1)], cancelRequested: false };
    const out2 = await finishTaskAndCheckIntegrity(run2, ctx, 't1', { kind: 'errored' });
    assert.equal(out2.kind, 'errored');
    assert.equal(run2.cancelRequested, false);
  });
});
