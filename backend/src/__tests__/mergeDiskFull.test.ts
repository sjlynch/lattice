// A merge on a full disk (2026-09-24): a 22-task merge run started with no
// space left, every worktree-side `git merge` died part-way and left main's
// version of the files it had written (or zero-byte ones) in the worktree, and
// every later attempt refused with "Your local changes … would be
// overwritten". Pins: the residue is cleared (archived first) so the merge
// goes through; a failed attempt undoes exactly what it wrote; a merge refuses
// to start under the floor; a run halts once on a full disk; and the low-disk
// monitor asks for a merge only below the reserve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTempDir } from './helpers/tempDir.js';
import {
  clearMergeBlockingChanges,
  dirtyPathSet,
  readWorktreeDirtyPaths,
  restoreFailedMergeWrites,
} from '../worktree/merge/mergeResidue.js';
import { mergeWorktreeInRepo } from '../worktree/merge.js';
import { isDiskFullMessage, mergeDiskSpaceShortfall, MERGE_MIN_FREE_BYTES } from '../worktree/diskFull.js';
import { checkLowDiskOnce, resetDiskPressureMergeStateForTests } from '../diskPressureMerge.js';

const PREFIX = 'lattice-merge-diskfull-';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// main: a.txt b.txt c.txt. The task branch (in a worktree) commits a change to
// b.txt; main then changes a.txt, adds new.txt, and changes c.txt too (which
// the branch also changed — the three-way case).
async function fixture(base: string) {
  const repo = path.join(base, 'repo');
  const wt = path.join(base, 'wt');
  await fs.mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  for (const f of ['a', 'b', 'c']) await fs.writeFile(path.join(repo, `${f}.txt`), `${f}\n1\n2\n3\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['worktree', 'add', '-q', wt, '-b', 'lattice/task-x']);
  git(wt, ['config', 'user.email', 't@t']);
  await fs.writeFile(path.join(wt, 'b.txt'), 'b\n1\n2\n3\nbranch\n');
  await fs.writeFile(path.join(wt, 'c.txt'), 'c-branch\n1\n2\n3\n');
  git(wt, ['commit', '-qam', 'task work']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n1\n2\n3\nmain\n');
  await fs.writeFile(path.join(repo, 'c.txt'), 'c\n1\n2\n3\nmain\n');
  await fs.writeFile(path.join(repo, 'new.txt'), 'new on main\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'main moves']);
  const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();
  return { repo, wt, mainSha };
}

// What a merge that died writing the index leaves: main's a.txt, git's
// three-way c.txt, main's new file untracked, and a zero-byte cut-off write.
async function leaveMergeResidue(wt: string) {
  await fs.writeFile(path.join(wt, 'a.txt'), 'a\n1\n2\n3\nmain\n');
  await fs.writeFile(path.join(wt, 'c.txt'), '');
  await fs.writeFile(path.join(wt, 'new.txt'), 'new on main\n');
}

test('residue of a merge that died part-way is archived and cleared; the merge then goes through', async () => {
  await withTempDir(PREFIX, async (base) => {
    const { repo, wt, mainSha } = await fixture(base);
    await leaveMergeResidue(wt);
    // An unrelated uncommitted edit the agent left must survive untouched.
    await fs.writeFile(path.join(wt, 'notes.md'), 'agent scratch\n');

    // Without the fix git refuses outright.
    const refused = (() => {
      try { git(wt, ['merge', '--no-ff', '-m', 'm', mainSha]); return null; } catch (e) { return String((e as { stderr?: string }).stderr); }
    })();
    assert.match(refused ?? '', /would be overwritten|untracked working tree files/);

    const cleared = await clearMergeBlockingChanges(repo, wt, 'lattice/task-x', mainSha);
    assert.equal(cleared.ok, true);
    assert.ok(cleared.ok && cleared.cleared === 3 && cleared.archiveDir, JSON.stringify(cleared));
    // The archive holds a copy of everything that was uncommitted.
    const archived = await fs.readFile(path.join(cleared.ok ? cleared.archiveDir! : '', 'files', 'notes.md'), 'utf8');
    assert.equal(archived, 'agent scratch\n');
    assert.equal(await fs.readFile(path.join(wt, 'notes.md'), 'utf8'), 'agent scratch\n');
    assert.equal(git(wt, ['status', '--porcelain', '--untracked-files=all']).trim(), '?? notes.md');

    git(wt, ['merge', '--no-ff', '-m', 'merge main', mainSha]);
    assert.match(await fs.readFile(path.join(wt, 'c.txt'), 'utf8'), /c-branch[\s\S]*main/);
  });
});

test('mergeWorktreeInRepo clears the residue itself and merges clean', async () => {
  await withTempDir(PREFIX, async (base) => {
    const { repo, wt } = await fixture(base);
    await leaveMergeResidue(wt);
    const outcome = await mergeWorktreeInRepo(repo, 'lattice/task-x', wt, 't_disk', 'http://127.0.0.1:1', 'disk fixture');
    assert.equal(outcome.status, 'clean', JSON.stringify(outcome));
    assert.equal(git(wt, ['rev-list', '--count', 'HEAD..main']).trim(), '0');
  });
});

test('a failed merge attempt is undone path by path; what was dirty before is left alone', async () => {
  await withTempDir(PREFIX, async (base) => {
    const { wt } = await fixture(base);
    await fs.writeFile(path.join(wt, 'b.txt'), 'agent edit, uncommitted\n');
    const before = dirtyPathSet((await readWorktreeDirtyPaths(wt))!);
    assert.deepEqual([...before], ['b.txt']);
    await leaveMergeResidue(wt); // the attempt's writes
    const r = await restoreFailedMergeWrites(wt, before);
    assert.deepEqual(r, { restored: 3, failed: [] });
    assert.equal(await fs.readFile(path.join(wt, 'b.txt'), 'utf8'), 'agent edit, uncommitted\n');
    assert.equal(git(wt, ['status', '--porcelain', '--untracked-files=all']).trim(), 'M b.txt');
  });
});

test('merge refuses to start under the free-space floor; disk-full wordings are recognised', async () => {
  const free = new Map([['/ok', MERGE_MIN_FREE_BYTES * 5], ['/full', 12 * 1024 ** 2]]);
  const deps = { freeBytesAt: async (p: string) => free.get(p) ?? null };
  assert.equal(await mergeDiskSpaceShortfall(['/ok', '/unknown'], deps), null);
  const msg = await mergeDiskSpaceShortfall(['/ok', '/full'], deps);
  assert.match(msg ?? '', /not enough free disk space to merge safely: 12 MB free/);
  assert.ok(isDiskFullMessage(msg!));
  for (const seen of [
    "fatal: sha1 file 'C:/r/.git/worktrees/x/index.lock' write error. Out of diskspace",
    'fatal: unable to write loose object file: No space left on device',
    'Failed to snapshot before fast-forward: not enough disk space to snapshot 0 MB',
    "ENOSPC: no space left on device, write",
  ]) assert.ok(isDiskFullMessage(seen), seen);
  assert.ok(!isDiskFullMessage('CONFLICT (content): Merge conflict in a.txt'));
});

test('a merge run halts once on a full disk instead of failing every remaining task', async () => {
  const { finishTaskAndCheckIntegrity } = await import('../mergeRuns/repoIntegrity.js');
  const { createRunState } = await import('../mergeRuns/state.js');
  await withTempDir(PREFIX, async (base) => {
    const { repo } = await fixture(base);
    const state = createRunState();
    state.emit = () => {};
    const run = {
      id: 'run-disk', projectPath: repo, status: 'running' as const, startedAt: 1, total: 22,
      processed: 0, merged: [], conflicted: [],
      errored: [{ taskId: 't1', error: "fatal: sha1 file 'C:/r/.git/worktrees/x/index.lock' write error. Out of diskspace" }],
      cancelRequested: false,
    };
    const ctx = { projectPath: repo, backendOrigin: 'http://unused', baselineHead: null as string | null, state };
    const out = await finishTaskAndCheckIntegrity(run, ctx, 't1', { kind: 'errored' });
    assert.equal(out.kind, 'disk-halt');
    assert.equal(run.cancelRequested, true);
    assert.match(run.errored.at(-1)?.error ?? '', /disk is \(nearly\) full.*21 task\(s\) stay Ready to Merge/s);

    const other = { ...run, errored: [{ taskId: 't2', error: 'CONFLICT (content)' }], cancelRequested: false };
    assert.equal((await finishTaskAndCheckIntegrity(other, ctx, 't2', { kind: 'errored' })).kind, 'errored');
  });
});

test('the low-disk monitor asks for a merge only for projects under the reserve, and logs the crossing once', async () => {
  resetDiskPressureMergeStateForTests();
  const GB = 1024 ** 3;
  const free = new Map<string, number>();
  const asked: string[] = [];
  const projects = [path.resolve('/proj/full'), path.resolve('/proj/fine')];
  // Free space per project, keyed by the worktree dir the monitor measures.
  const deps = {
    forEachProject: async (fn: (p: string) => Promise<void>) => { for (const p of projects) await fn(p); },
    freeBytesAt: async (target: string) => free.get(target) ?? null,
    minFreeBytes: async () => 10 * GB,
    requestMerge: async (p: string) => { asked.push(p); return 'started' as const; },
  };
  const { homeWorktreesDir } = await import('../projectPath.js');
  free.set(homeWorktreesDir(projects[0]), 2 * GB);
  free.set(homeWorktreesDir(projects[1]), 40 * GB);
  await checkLowDiskOnce(deps);
  assert.deepEqual(asked, [projects[0]]);
  free.set(homeWorktreesDir(projects[0]), 20 * GB);
  asked.length = 0;
  await checkLowDiskOnce(deps);
  assert.deepEqual(asked, []);
});
