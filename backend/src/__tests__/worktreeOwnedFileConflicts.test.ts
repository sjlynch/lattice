// Lattice-owned-file conflict auto-resolve in the worktree merge
// (worktree/conflictResolve.ts + worktree/merge/conflict.ts).
//
// `.claude/settings.local.json` carries a task-specific Stop hook. Once main
// tracks it (a resolver's `git add -A`, an old worktree), every worktree merge
// either conflicts on it or aborts before it starts:
//
//   - a conflict leaves markers IN the JSON, and the resolver Claude spawned
//     into that worktree reads the file at bootstrap — malformed JSON is a
//     "Settings Error" prompt before its brief is processed, so the resolver
//     never runs. `resolveOwnedFileConflicts` takes "ours" and de-indexes it;
//     `handleMergeConflict` commits the merge itself when nothing else
//     conflicts (`[lattice-auto]` in the message).
//   - a tracked owned file with an uncommitted per-task edit makes git refuse
//     with "Your local changes … would be overwritten by merge" before any
//     conflict exists. `resetOwnedFileLocalChanges` puts HEAD's copy back first.
//
// Nothing covered either path before this file. A regression aborts every merge
// where main tracks an owned file, spawns resolvers into a broken session, or
// commits one task's Stop hook onto main. Real temp repos throughout; HOME is
// isolated, so the identity is set on each temp repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTempDir } from './helpers/tempDir.js';
import { mergeWorktreeInRepo } from '../worktree/merge.js';
import {
  resetOwnedFileLocalChanges,
  resolveOwnedFileConflicts,
} from '../worktree/conflictResolve.js';
import { renderStopHookJson } from '../worktree/stopHook.js';
import { isMidMerge } from '../worktree/state.js';

const PREFIX = 'lattice-owned-conflict-';
const OWNED = '.claude/settings.local.json';
const BRANCH = 'lattice/task-owned';
const TASK_ID = 't_owned_task';
const ORIGIN = 'http://127.0.0.1:1';
// The worktree's own hook vs another task's hook that main picked up.
const OURS_HOOK = renderStopHookJson(TASK_ID, ORIGIN);
const THEIRS_HOOK = renderStopHookJson('t_some_other_task', ORIGIN);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

// Identity per repo (HOME is isolated); autocrlf off so Git for Windows' system
// config can't rewrite checked-out files to CRLF under the byte comparisons.
async function initRepo(repo: string): Promise<void> {
  await fs.mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'core.autocrlf', 'false']);
}

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, ...rel.split('/')), 'utf8');
const tracked = (dir: string, rev: string) =>
  git(dir, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean);

// main (repo) and a task worktree on BRANCH, both starting from a base that
// already tracks the owned file (the accidental commit this code defends
// against). `sourceConflict` also has both sides edit the same line of a.txt.
async function fixture(base: string, opts: { sourceConflict?: boolean } = {}) {
  const repo = path.join(base, 'repo');
  const wt = path.join(base, 'wt');
  await initRepo(repo);
  await write(repo, 'a.txt', 'a\n1\n2\n3\n');
  await write(repo, OWNED, '{"base":true}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base (owned file tracked by accident)']);

  git(repo, ['worktree', 'add', '-q', wt, '-b', BRANCH]);
  await write(wt, OWNED, OURS_HOOK);
  await write(wt, 'task.txt', 'task work\n');
  if (opts.sourceConflict) await write(wt, 'a.txt', 'a-branch\n1\n2\n3\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'task work']);

  await write(repo, OWNED, THEIRS_HOOK);
  await write(repo, 'main.txt', 'main work\n');
  if (opts.sourceConflict) await write(repo, 'a.txt', 'a-main\n1\n2\n3\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'main moves']);
  return { repo, wt, mainSha: git(repo, ['rev-parse', 'HEAD']).trim() };
}

const merge = (repo: string, wt: string) =>
  mergeWorktreeInRepo(repo, BRANCH, wt, TASK_ID, ORIGIN, 'owned fixture');

test('an owned-file-only conflict is auto-resolved and committed; main never gets the Stop hook', async () => {
  await withTempDir(PREFIX, async (base) => {
    const { repo, wt, mainSha } = await fixture(base);

    const outcome = await merge(repo, wt);
    assert.deepEqual(outcome, { status: 'clean' });

    // The merge commit is Lattice's own, and it absorbed main.
    const message = git(wt, ['log', '-1', '--format=%B', 'HEAD']);
    assert.match(message, /^Merge main → owned fixture/);
    assert.match(message, /\[lattice-auto\] auto-resolved owned files: \.claude\/settings\.local\.json/);
    assert.equal(git(wt, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3);
    assert.equal(git(wt, ['rev-list', '--count', `HEAD..${mainSha}`]).trim(), '0');
    assert.equal(await isMidMerge(wt), false);

    // The owned file is out of the merge commit, so the FF can't land it on main.
    const files = tracked(wt, 'HEAD');
    assert.ok(!files.includes(OWNED), `${OWNED} must not be tracked in the merge commit: ${files.join(', ')}`);
    assert.ok(files.includes('main.txt') && files.includes('task.txt'));
    assert.equal(git(wt, ['ls-files', '--', OWNED]).trim(), '');
    assert.equal(git(wt, ['status', '--porcelain', '--untracked-files=no']).trim(), '');

    // The worktree keeps its OWN task's Stop hook, not main's.
    assert.equal(await read(wt, OWNED), OURS_HOOK);
  });
});

test('with a real source conflict too, only the source file is left for the resolver', async () => {
  await withTempDir(PREFIX, async (base) => {
    const { repo, wt } = await fixture(base, { sourceConflict: true });

    const outcome = await merge(repo, wt);
    assert.deepEqual(outcome, { status: 'conflict', conflictKind: 'merge', conflictedFiles: ['a.txt'] });

    // Still mid-merge with a.txt unmerged; the owned file is resolved (out of
    // the index, no markers) so the resolver's session bootstraps.
    assert.equal(git(wt, ['diff', '--name-only', '--diff-filter=U']).trim(), 'a.txt');
    assert.equal(git(wt, ['ls-files', '--', OWNED]).trim(), '');
    const hook = await read(wt, OWNED);
    assert.doesNotMatch(hook, /^(<<<<<<<|=======|>>>>>>>)/m);
    assert.equal(hook, OURS_HOOK);
    JSON.parse(hook);
    assert.match(await read(wt, 'a.txt'), /<<<<<<<[\s\S]*a-branch[\s\S]*a-main/);
  });
});

test("a tracked owned file with uncommitted edits doesn't abort the merge", async () => {
  await withTempDir(PREFIX, async (base) => {
    // Base tracks the owned file; only main changes it (so the merge must
    // write it), and the worktree holds an uncommitted per-task edit to it —
    // what installStopHook does to a worktree created from such a base.
    const repo = path.join(base, 'repo');
    const wt = path.join(base, 'wt');
    await initRepo(repo);
    await write(repo, 'a.txt', 'a\n');
    await write(repo, OWNED, '{"base":true}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);
    git(repo, ['worktree', 'add', '-q', wt, '-b', BRANCH]);
    await write(wt, 'task.txt', 'task work\n');
    git(wt, ['add', 'task.txt']);
    git(wt, ['commit', '-qm', 'task work']);
    await write(wt, OWNED, OURS_HOOK); // uncommitted
    await write(repo, OWNED, THEIRS_HOOK);
    git(repo, ['commit', '-qam', 'main edits the owned file']);
    const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();

    // Without the reset git refuses before producing any conflict.
    const refused = (() => {
      try { git(wt, ['merge', '--no-ff', '-m', 'm', mainSha]); return null; } catch (e) { return String((e as { stderr?: string }).stderr); }
    })();
    assert.match(refused ?? '', /local changes to the following files would be overwritten/);

    const outcome = await merge(repo, wt);
    assert.deepEqual(outcome, { status: 'clean' });
    assert.equal(git(wt, ['rev-list', '--count', `HEAD..${mainSha}`]).trim(), '0');
    // The post-merge untrack dropped the file main dragged in, and the task's
    // own hook is back on disk.
    assert.ok(!tracked(wt, 'HEAD').includes(OWNED));
    assert.equal(await read(wt, OWNED), OURS_HOOK);
  });
});

test("the auto-resolve commit failing is reported, not taken for a clean merge", async () => {
  await withTempDir(PREFIX, async (base) => {
    const { repo, wt } = await fixture(base);
    // A commit-msg hook that rejects everything: git merge stops on the
    // conflict before committing, so the only commit it can veto is ours.
    const hooks = path.join(base, 'hooks');
    await fs.mkdir(hooks);
    await fs.writeFile(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n', { mode: 0o755 });
    git(repo, ['config', 'core.hooksPath', hooks.replace(/\\/g, '/')]);

    const outcome = await merge(repo, wt);
    assert.equal(outcome.status, 'error');
    assert.match((outcome as { message: string }).message, /^Auto-resolve commit failed: /);
    assert.equal(git(wt, ['log', '-1', '--format=%s', 'HEAD']).trim(), 'task work');
  });
});

test('resolveOwnedFileConflicts takes ours for owned files and passes everything else through', async () => {
  await withTempDir(PREFIX, async (base) => {
    // A distinct "ours" marker (not a Stop hook) so installStopHook can't mask
    // the choice: this drives the resolver directly.
    const { wt, mainSha } = await fixture(base, { sourceConflict: true });
    await write(wt, OWNED, '{"ours":true}\n');
    git(wt, ['commit', '-qam', 'ours marker']);
    assert.throws(() => git(wt, ['merge', '--no-ff', '-m', 'm', mainSha]));

    const merged = await resolveOwnedFileConflicts(wt, 'merge');
    assert.deepEqual(merged, { resolved: [OWNED], remaining: ['a.txt'] });
    assert.equal(await read(wt, OWNED), '{"ours":true}\n');
    assert.equal(git(wt, ['ls-files', '--', OWNED]).trim(), '', "'merge' mode de-indexes the owned file");
  });
});

test('resetOwnedFileLocalChanges resets only tracked, modified owned files', async () => {
  await withTempDir(PREFIX, async (base) => {
    const repo = path.join(base, 'repo');
    await initRepo(repo);
    await write(repo, OWNED, '{"head":true}\n');
    await write(repo, '.pi/mcp.json', '{"head":true}\n');
    await write(repo, 'a.txt', 'a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);

    assert.deepEqual(await resetOwnedFileLocalChanges(repo), [], 'nothing modified → nothing reset');

    await write(repo, OWNED, OURS_HOOK); // tracked + modified → reset
    await write(repo, 'LATTICE_TASK.md', 'brief'); // owned but untracked → left alone
    await write(repo, 'a.txt', 'agent edit\n'); // not owned → left alone
    assert.deepEqual(await resetOwnedFileLocalChanges(repo), [OWNED]);
    assert.equal(await read(repo, OWNED), '{"head":true}\n');
    assert.equal(await read(repo, 'LATTICE_TASK.md'), 'brief');
    assert.equal(await read(repo, 'a.txt'), 'agent edit\n');
  });
});
