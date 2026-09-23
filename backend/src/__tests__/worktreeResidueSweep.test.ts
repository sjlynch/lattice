import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resetResidueSweepStateForTests,
  sweepWorktreeResidue,
  type ResidueSweepDeps,
} from '../recovery/worktreeResidueSweep.js';
import {
  requestWorktreeResidueSweep,
  resetWorktreeResidueSweepLoopForTests,
  runWorktreeResidueSweepPass,
  type ResidueSweepPassDeps,
} from '../recovery/worktreeResidueSweepLoop.js';
import { normalizeCwd } from '../recovery/liveSessions.js';
import type { Task } from '../tasks.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

// Residue = what a part-failed `git worktree remove` leaves: registration and
// `.git` already gone, source dirs (not just node_modules) still there.

const HOUR = 60 * 60_000;
const OLD = new Date(Date.now() - 2 * HOUR);

type Porcelain = () => string;

function porcelain(...paths: string[]): string {
  return ['worktree C:/repo', 'branch refs/heads/main', '', ...paths.flatMap((p) => [`worktree ${p}`, '']), ''].join('\0');
}

function sweepDeps(base: string, list: Porcelain, overrides: Partial<ResidueSweepDeps> = {}) {
  const removed: string[] = [];
  let freed = 0;
  const deps: ResidueSweepDeps = {
    projectGit: (async () => ({ code: 0, stdout: list(), stderr: '' })) as never,
    removeDir: async (d) => {
      removed.push(path.basename(d));
      await fs.rm(d, { recursive: true, force: true });
      return true;
    },
    now: () => Date.now(),
    worktreesDir: () => base,
    notifyDiskSpaceFreed: () => { freed += 1; },
    ...overrides,
  };
  return { deps, removed, freed: () => freed };
}

// Populate a dir, then age it (writing inside a dir bumps its mtime).
async function mkResidue(base: string, name: string, files: Record<string, string>, mtime = OLD) {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  await writeLayout(dir, files);
  await fs.utimes(dir, mtime, mtime);
  return dir;
}

async function sweep(base: string, deps: ResidueSweepDeps, tasks: Task[] = [], live = new Set<string>()) {
  return sweepWorktreeResidue('C:\\repo', tasks, live, deps.projectGit, deps, { logPrefix: '[test]' });
}

test('residue with source files (no node_modules) is removed; checkouts and fresh dirs are kept', async (t) => {
  resetResidueSweepStateForTests();
  t.mock.method(console, 'log', () => undefined);
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'residue-src', { 'packages/app/index.ts': 'x', 'src/main.ts': 'y' });
    await mkResidue(base, 'residue-mixed', { 'node_modules/a/i.js': 'x', 'tmp/out.log': 'z' });
    await mkResidue(base, 'empty', {});
    await mkResidue(base, 'has-git', { '.git': 'gitdir: C:/repo/.git/worktrees/has-git', 'a.ts': 'x' });
    const registered = await mkResidue(base, 'registered', { 'a.ts': 'x' });
    const inProgress = await mkResidue(base, 'owned-in-progress', { 'a.ts': 'x' });
    const ready = await mkResidue(base, 'owned-ready', { 'a.ts': 'x' });
    const queued = await mkResidue(base, 'owned-queued', { 'a.ts': 'x' });
    const live = await mkResidue(base, 'live-pty', { 'a.ts': 'x' });
    await mkResidue(base, 'fresh', { 'a.ts': 'x' }, new Date());
    await fs.writeFile(path.join(base, 'stray-file.txt'), 'not a dir');

    const tasks = [
      { id: 'a', status: 'in_progress', worktreePath: inProgress },
      { id: 'b', status: 'ready_to_merge', worktreePath: ready },
      { id: 'c', status: 'open', runQueued: true, worktreePath: queued },
    ] as unknown as Task[];
    const { deps, removed, freed } = sweepDeps(base, () => porcelain(registered.replace(/\\/g, '/')));
    const n = await sweep(base, deps, tasks, new Set([normalizeCwd(path.join(live, 'packages'))]));

    assert.equal(n, 3);
    assert.deepEqual(removed.sort(), ['empty', 'residue-mixed', 'residue-src']);
    assert.deepEqual((await fs.readdir(base)).sort(), [
      'fresh', 'has-git', 'live-pty', 'owned-in-progress', 'owned-queued', 'owned-ready', 'registered', 'stray-file.txt',
    ]);
    assert.equal(freed(), 1);
  });
});

test('a registration reported under another spelling of the hash dir still protects the checkout', async () => {
  resetResidueSweepStateForTests();
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'task-abc', { 'a.ts': 'x' });
    const alias = `C:/SPENC~1/.lattice/worktrees/${path.basename(base)}/task-abc`;
    const { deps, removed } = sweepDeps(base, () => porcelain(alias));
    assert.equal(await sweep(base, deps), 0);
    assert.deepEqual(removed, []);
  });
});

test('an unreadable registration list removes nothing', async () => {
  resetResidueSweepStateForTests();
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'residue', { 'a.ts': 'x' });
    const { deps, removed } = sweepDeps(base, () => '', {
      projectGit: (async () => ({ code: 128, stdout: '', stderr: 'fatal' })) as never,
    });
    assert.equal(await sweep(base, deps), 0);
    assert.deepEqual(removed, []);
  });
});

test('registration and .git are re-checked immediately before each delete', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  resetResidueSweepStateForTests();
  await withTempDir('lattice-residue-', async (base) => {
    const becomesRegistered = await mkResidue(base, 'a-becomes-registered', { 'a.ts': 'x' });
    const gainsGit = await mkResidue(base, 'b-gains-git', { 'a.ts': 'x' });
    await mkResidue(base, 'c-plain', { 'a.ts': 'x' });
    let lists = 0;
    // 1st list = the inventory; 2nd = re-check for "a" (a setup just
    // registered it); 3rd = re-check for "b" (a setup wrote its .git
    // meanwhile); 4th = re-check for "c".
    const { deps, removed } = sweepDeps(base, () => {
      lists += 1;
      return lists === 2 ? porcelain(becomesRegistered) : porcelain();
    });
    const realGit = deps.projectGit;
    deps.projectGit = (async (...args: Parameters<typeof realGit>) => {
      if (lists === 2) await fs.writeFile(path.join(gainsGit, '.git'), 'gitdir: elsewhere');
      return realGit(...args);
    }) as never;
    assert.equal(await sweep(base, deps), 1);
    assert.deepEqual(removed, ['c-plain']);
    assert.equal(lists, 4);
    assert.ok((await fs.lstat(becomesRegistered)).isDirectory());
    assert.ok((await fs.lstat(path.join(gainsGit, '.git'))).isFile());
  });
});

test('a locked dir backs off before being retried, then is removed', async (t) => {
  resetResidueSweepStateForTests();
  t.mock.method(console, 'log', () => undefined);
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'locked', { 'node_modules/esbuild.exe': 'x', 'src/a.ts': 'y' });
    let now = Date.now();
    let locked = true;
    const attempts: number[] = [];
    const { deps, freed } = sweepDeps(base, () => porcelain(), {
      now: () => now,
      removeDir: async (d) => {
        attempts.push(now);
        if (locked) return false;
        await fs.rm(d, { recursive: true, force: true });
        return true;
      },
    });
    assert.equal(await sweep(base, deps), 0);
    assert.equal(attempts.length, 1);
    assert.equal(freed(), 1, 'a failed rm still deletes around the lock');

    now += 10 * 60_000; // inside the first backoff window
    assert.equal(await sweep(base, deps), 0);
    assert.equal(attempts.length, 1, 'not retried while backing off');

    now += 25 * 60_000; // past 30 min: retried, still locked → longer backoff
    assert.equal(await sweep(base, deps), 0);
    assert.equal(attempts.length, 2);

    now += 45 * 60_000; // inside the doubled (60 min) window
    await sweep(base, deps);
    assert.equal(attempts.length, 2);

    now += 20 * 60_000;
    locked = false;
    assert.equal(await sweep(base, deps), 1);
    assert.equal(attempts.length, 3);
    assert.deepEqual(await fs.readdir(base), []);
  });
});

test('a summary is logged only when the counts change', async (t) => {
  resetResidueSweepStateForTests();
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(String(args[0])));
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'locked', { 'a.ts': 'x' });
    const { deps } = sweepDeps(base, () => porcelain(), { removeDir: async () => false });
    await sweep(base, deps);
    await sweep(base, deps); // now waiting out the backoff: 0 locked, 1 waiting
    await sweep(base, deps); // unchanged → silent
    const summaries = lines.filter((l) => l.includes('residue sweep:') && l.includes('still locked'));
    assert.equal(summaries.length, 2, lines.join('\n'));
    assert.ok(summaries.every((l) => l.startsWith('[test] ')));
  });
});

test('a removed dir logs its top-level entries', async (t) => {
  resetResidueSweepStateForTests();
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(String(args[0])));
  await withTempDir('lattice-residue-', async (base) => {
    await mkResidue(base, 'residue', { 'tmp/x.log': 'x', 'packages/a.ts': 'y' });
    const { deps } = sweepDeps(base, () => porcelain());
    await sweep(base, deps);
    assert.ok(lines.some((l) => /removed .*residue \(top-level: packages, tmp\)/.test(l)), lines.join('\n'));
  });
});

function passDeps(overrides: Partial<ResidueSweepPassDeps> = {}) {
  const swept: string[] = [];
  const deps: ResidueSweepPassDeps = {
    forEachKnownProjectSafely: async (_label, fn) => {
      for (const p of ['C:\\with-git', 'C:\\no-git', 'C:\\no-tasks']) await fn(p);
    },
    gitDirExists: async (p) => p !== 'C:\\no-git',
    listTasks: async (p) => (p === 'C:\\no-tasks' ? [] : [{ id: 't', status: 'qa' } as Task]),
    projectGit: (async () => ({ code: 0, stdout: '', stderr: '' })) as never,
    collectLiveSessionCwds: async () => new Set<string>(),
    sweepResidue: async (repoRoot) => { swept.push(repoRoot); return 0; },
    ...overrides,
  };
  return { deps, swept };
}

test('a periodic pass sweeps only known projects that have .git and task records', async () => {
  resetWorktreeResidueSweepLoopForTests();
  const { deps, swept } = passDeps();
  await runWorktreeResidueSweepPass(deps);
  assert.deepEqual(swept, ['C:\\with-git']);
});

test('a periodic pass is skipped when the terminal-server is unreachable', async (t) => {
  resetWorktreeResidueSweepLoopForTests();
  t.mock.method(console, 'warn', () => undefined);
  const { deps, swept } = passDeps({ collectLiveSessionCwds: async () => null });
  await runWorktreeResidueSweepPass(deps);
  assert.deepEqual(swept, []);
});

test('passes are single-flight and disk-wait requests are coalesced', async () => {
  resetWorktreeResidueSweepLoopForTests();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let passes = 0;
  const { deps } = passDeps({
    forEachKnownProjectSafely: async () => { passes += 1; await gate; },
  });
  const first = runWorktreeResidueSweepPass(deps);
  const second = runWorktreeResidueSweepPass(deps);
  assert.equal(first, second, 'a pass in flight is joined, not duplicated');
  assert.equal(requestWorktreeResidueSweep(deps), false);
  release();
  await first;
  assert.equal(passes, 1);
  assert.equal(requestWorktreeResidueSweep(deps), false, 'within the minimum gap of the last pass');
  resetWorktreeResidueSweepLoopForTests();
  assert.equal(requestWorktreeResidueSweep(deps), true);
});
