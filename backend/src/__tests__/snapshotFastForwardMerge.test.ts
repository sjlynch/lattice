import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fastForwardMain } from '../worktree/merge.js';
import { snapshotWorkingTree } from '../worktree/snapshot/capture.js';
import { readSnapshotManifest, snapshotManifestPath } from '../worktree/snapshot/manifest.js';
import { runTeardown } from '../mergeRuns/teardown.js';
import type { MergeRun } from '../mergeRuns/state.js';

// Regression for: "restoring the user's snapshot after a fast-forward
// overwrites the merged task's change to the same file". The user has an
// uncommitted edit to one hunk of a file; the task changed a different hunk.
// The pre-FF snapshot captured the user's copy (the FF rewrites the file) and
// reset it; the FF wrote the task's version; the restore then saw a file
// "clean against the new HEAD" and overlaid the user's PRE-merge copy — HEAD
// had the task's change, the working tree silently reverted it, reported as
// `restored`. Now the captured copy is three-way merged with what landed.

const BASE = 'A\nB\nC\n';

async function repoFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-ff-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  // Byte-exact fixtures: no CRLF conversion under a global core.autocrlf.
  git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(repo, 'tracked.txt'), BASE);
  git('add', '--', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.lattice/\nnode_modules/\n');
  // A task branch that changes tracked.txt (or deletes it, with null).
  const taskBranch = async (branch: string, content: string | null) => {
    git('checkout', '-b', branch);
    if (content === null) git('rm', '--quiet', '--', 'tracked.txt');
    else {
      await fs.writeFile(path.join(repo, 'tracked.txt'), content);
      git('add', '--', 'tracked.txt');
    }
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', `task ${branch}`);
    git('checkout', 'main');
  };
  return { root, repo, git, taskBranch, tracked: path.join(repo, 'tracked.txt') };
}

function makeRun(projectPath: string): MergeRun {
  return {
    id: 'run_ff_merge',
    projectPath,
    status: 'running',
    startedAt: 1,
    total: 0,
    processed: 0,
    merged: [],
    conflicted: [],
    errored: [],
    cancelRequested: false,
  };
}

test('fastForwardMain keeps both the merged change and the user\'s edit to another hunk of the same file', async (t) => {
  const { repo, git, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-a', 'A task\nB\nC\n');
  await fs.writeFile(tracked, 'A\nB\nC user\n');

  const outcome = await fastForwardMain(repo, 'lattice/edit-a');

  assert.deepEqual(outcome, { status: 'clean' }, 'combined cleanly: no snapshot warning');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'lattice/edit-a'));
  assert.equal(await fs.readFile(tracked, 'utf8'), 'A task\nB\nC user\n');
  // Relative to the new HEAD only the user's own edit is uncommitted — the
  // task's hunk is not reverted in the working tree.
  const diff = git('diff', 'HEAD', '--', 'tracked.txt');
  assert.match(diff, /^\+C user$/m);
  assert.doesNotMatch(diff, /^-A task$/m);
  await assert.rejects(fs.access(`${tracked}.lattice-conflict`), { code: 'ENOENT' });
});

test('fastForwardMain surfaces an overlapping edit as a conflict and loses neither side', async (t) => {
  const { repo, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-c', 'A\nB\nC task\n');
  await fs.writeFile(tracked, 'A\nB\nC user\n');

  const outcome = await fastForwardMain(repo, 'lattice/edit-c');

  if (outcome.status !== 'clean') assert.fail(`the fast-forward itself should land: ${JSON.stringify(outcome)}`);
  assert.ok(outcome.snapshotWarning, 'the partial restore is reported');
  assert.match(outcome.snapshotWarning, /^Snapshot partly restored/);
  assert.match(outcome.snapshotWarning, /tracked\.txt/);
  assert.match(outcome.snapshotWarning, /\.lattice-conflict/);
  // The merged change stays in the working tree — no conflict markers in a
  // file vite may be watching — and the user's copy sits beside it.
  assert.equal(await fs.readFile(tracked, 'utf8'), 'A\nB\nC task\n');
  assert.equal(await fs.readFile(`${tracked}.lattice-conflict`, 'utf8'), 'A\nB\nC user\n');
});

test('fastForwardMain does not resurrect a file the merge deleted when the user had edited it', async (t) => {
  const { repo, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/delete', null);
  await fs.writeFile(tracked, 'A\nB\nC user\n');

  const outcome = await fastForwardMain(repo, 'lattice/delete');

  if (outcome.status !== 'clean') assert.fail(`the fast-forward itself should land: ${JSON.stringify(outcome)}`);
  assert.ok(outcome.snapshotWarning, 'the deletion conflict is reported');
  assert.match(outcome.snapshotWarning, /tracked\.txt/);
  await assert.rejects(fs.access(tracked), { code: 'ENOENT' });
  assert.equal(await fs.readFile(`${tracked}.lattice-conflict`, 'utf8'), 'A\nB\nC user\n');
});

test('the capture records its base commit in the handle and the manifest', async (t) => {
  const { repo, git, tracked } = await repoFixture(t);
  await fs.writeFile(tracked, 'A\nB\nC user\n');
  const snapshot = await snapshotWorkingTree(repo, 'test');
  assert.equal(snapshot.baseCommit, git('rev-parse', 'HEAD'));
  const manifest = await readSnapshotManifest(snapshotManifestPath(snapshot.dir));
  assert.equal(manifest?.baseCommit, git('rev-parse', 'HEAD'));
});

test('run-level teardown merges the run snapshot with a change the run fast-forwarded', async (t) => {
  const { repo, git, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-a', 'A task\nB\nC\n');
  await fs.writeFile(tracked, 'A\nB\nC user\n');
  // The merge run's snapshot, then one of its fast-forwards.
  const snapshot = await snapshotWorkingTree(repo, 'run', { onlyPaths: ['tracked.txt'] });
  assert.equal(await fs.readFile(tracked, 'utf8'), BASE, 'captured and reset');
  git('merge', '--ff-only', 'lattice/edit-a');

  const run = makeRun(repo);
  // 'inherit' skips the auto-restart probe of the task store.
  await runTeardown(repo, run, snapshot, [], 'inherit');

  assert.deepEqual(run.errored, []);
  assert.equal(await fs.readFile(tracked, 'utf8'), 'A task\nB\nC user\n');
  await assert.rejects(fs.access(snapshot.dir), { code: 'ENOENT' }, 'fully restored snapshots are removed');
});

test('run-level teardown reports an overlapping edit as a run error naming the conflict copy', async (t) => {
  const { repo, git, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-c', 'A\nB\nC task\n');
  await fs.writeFile(tracked, 'A\nB\nC user\n');
  const snapshot = await snapshotWorkingTree(repo, 'run', { onlyPaths: ['tracked.txt'] });
  git('merge', '--ff-only', 'lattice/edit-c');

  const run = makeRun(repo);
  await runTeardown(repo, run, snapshot, [], 'inherit');

  assert.equal(run.errored.length, 1);
  assert.equal(run.errored[0].taskId, '(snapshot)');
  assert.match(run.errored[0].error, /tracked\.txt/);
  assert.match(run.errored[0].error, /\.lattice-conflict/);
  assert.equal(await fs.readFile(tracked, 'utf8'), 'A\nB\nC task\n');
  assert.equal(await fs.readFile(`${tracked}.lattice-conflict`, 'utf8'), 'A\nB\nC user\n');
});
