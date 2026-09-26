import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fastForwardMain } from '../worktree/merge.js';
import { snapshotWorkingTree } from '../worktree/snapshot/capture.js';
import { SNAPSHOTS_BASE, readSnapshotManifest, snapshotManifestPath } from '../worktree/snapshot/manifest.js';
import { restoreSnapshot } from '../worktree/snapshot/restore.js';
import { MAX_THREE_WAY_MERGE_BYTES, reconcileWithCommittedChange } from '../worktree/snapshot/threeWay.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import { projectRunLockFilePath } from '../projectRunLock/paths.js';
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
// Non-text/oversized inputs must instead keep both versions byte-for-byte:
// decoding invalid UTF-8 or overlaying the copy would corrupt one side.

const BASE = 'A\nB\nC\n';

async function repoFixture(t: { after: (fn: () => Promise<unknown>) => void }, base: string | Buffer = BASE) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-ff-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' }).toString().trim();
  git('init', '-b', 'main');
  // Byte-exact fixtures: no CRLF conversion under a global core.autocrlf.
  git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(repo, 'tracked.txt'), base);
  git('add', '--', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.lattice/\nnode_modules/\n');
  // A task branch that changes tracked.txt (or deletes it, with null).
  const taskBranch = async (branch: string, content: string | Buffer | null) => {
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

// Snapshot dirs captured for `repo` under ~/.lattice/snapshots (the test
// preload isolates HOME, so this is a throwaway dir).
function snapshotsOf(repo: string): string[] {
  const parent = path.join(SNAPSHOTS_BASE, projectHash(repo));
  return existsSync(parent) ? readdirSync(parent).map((name) => path.join(parent, name)) : [];
}

// Main gains a commit the task branch lacks, so `merge --ff-only` is refused.
async function divergeMain(repo: string, git: (...args: string[]) => string) {
  await fs.writeFile(path.join(repo, 'other.txt'), 'main moved on\n');
  git('add', '--', 'other.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'main moved on');
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

// The first three cases edit opposite ends of the file. In the last case
// both sides made the same valid-text edit to an invalid base. None can be
// refused merely because text hunks overlap: assert the refusal category.
const refusalCases: {
  name: string;
  base: Buffer;
  captured: Buffer;
  committed: Buffer;
  reason: RegExp;
  oversized?: boolean;
  restore?: boolean;
}[] = [
  {
    name: 'a captured source containing NUL',
    base: Buffer.from(BASE),
    captured: Buffer.from('A\nB\nC user\0\n'),
    committed: Buffer.from('A task\nB\nC\n'),
    reason: /not mergeable as text/,
  },
  {
    name: 'a committed destination containing invalid UTF-8 without NUL',
    base: Buffer.from(BASE),
    captured: Buffer.from('A\nB\nC caf\u00e9 user\r\n'),
    committed: Buffer.concat([Buffer.from('A task '), Buffer.from([0xff]), Buffer.from('\nB\nC\n')]),
    reason: /not mergeable as text/,
    restore: true,
  },
  {
    name: 'a captured source one byte over the merge limit before reading it',
    base: Buffer.from(BASE),
    captured: Buffer.concat([
      Buffer.from('A\nB\n'), Buffer.alloc(MAX_THREE_WAY_MERGE_BYTES - 4, 'x'), Buffer.from('\n'),
    ]),
    committed: Buffer.from('A task\nB\nC\n'),
    reason: /not mergeable as text/,
    oversized: true,
  },
  {
    name: 'an invalid UTF-8 base even when both current inputs are valid text',
    base: Buffer.concat([Buffer.from('A '), Buffer.from([0xff]), Buffer.from('\nB\nC\n')]),
    captured: Buffer.from('A caf\u00e9\nB\nC\n'),
    committed: Buffer.from('A caf\u00e9\nB\nC\n'),
    reason: /pre-merge version could not be read as text/,
  },
];

for (const fixture of refusalCases) {
  test(`three-way reconciliation refuses ${fixture.name}`, async (t) => {
    const { root, repo, git, taskBranch, tracked } = await repoFixture(t, fixture.base);
    const baseCommit = git('rev-parse', 'HEAD');
    await taskBranch('lattice/refusal', fixture.committed);
    git('checkout', 'lattice/refusal');
    assert.notEqual(
      git('rev-parse', `${baseCommit}:tracked.txt`), git('rev-parse', 'HEAD:tracked.txt'),
      'different blobs force reconciliation instead of the overlay shortcut',
    );
    assert.equal(git('status', '--porcelain'), '', 'the destination is clean tracked HEAD');
    assert.deepEqual(
      execFileSync('git', ['cat-file', 'blob', `${baseCommit}:tracked.txt`], { cwd: repo, windowsHide: true }),
      fixture.base,
    );
    // A local captured copy and real base commit suffice; no FF/workflow.
    const dir = path.join(root, 'snapshot');
    await fs.mkdir(dir);
    const source = path.join(dir, 'tracked.txt');
    await fs.writeFile(source, fixture.captured);
    if (fixture.oversized) assert.equal((await fs.stat(source)).size, MAX_THREE_WAY_MERGE_BYTES + 1);

    // Limit the read spy to reconciliation so the byte-preservation checks
    // below cannot count as reads of the oversized input.
    const read = fixture.oversized ? t.mock.method(fs, 'readFile') : undefined;
    try {
      const outcome = await reconcileWithCommittedChange(repo, baseCommit, 'tracked.txt', source, tracked);
      if (outcome.kind !== 'conflict') assert.fail(`expected refusal: ${outcome.kind}`);
      assert.match(outcome.reason, fixture.reason);
      if (read) {
        assert.ok(read.mock.calls.some(({ arguments: args }) => args[0] === tracked), 'the spy observes destination reads');
        assert.ok(
          !read.mock.calls.some(({ arguments: args }) => args[0] === source),
          'the size guard must refuse before reading source contents',
        );
      }
    } finally {
      read?.mock.restore();
    }
    assert.deepEqual(await fs.readFile(source), fixture.captured, 'reconciliation preserves the captured bytes');
    assert.deepEqual(await fs.readFile(tracked), fixture.committed, 'reconciliation preserves the committed bytes');

    if (fixture.restore) {
      // Reuse the invalid-destination case to cover the normal in-session
      // restore and its conflict-copy handoff, with no stale-overwrite flag.
      const result = await restoreSnapshot({ dir, modifiedTracked: ['tracked.txt'], untracked: [], baseCommit }, repo);
      assert.deepEqual(result, {
        status: 'partial', restored: [], failed: [], retained: true,
        conflicts: [{ file: 'tracked.txt', backupPath: `${tracked}.lattice-conflict` }],
      });
      assert.ok((await fs.stat(dir)).isDirectory(), 'the snapshot is retained');
      assert.deepEqual(await fs.readFile(source), fixture.captured, 'the retained snapshot is byte-exact');
      assert.deepEqual(await fs.readFile(tracked), fixture.committed, 'restore keeps the committed destination byte-exact');
      assert.deepEqual(await fs.readFile(result.conflicts[0].backupPath), fixture.captured, 'the reported conflict copy is byte-exact');
      git('diff', '--exit-code', 'HEAD', '--', 'tracked.txt');
    }
  });
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

// Failure paths: the FF is refused while the user's uncommitted edit sits in
// the pre-FF snapshot. If the failure-path restore regresses, the edit
// silently vanishes from the working tree.

// Byte-exact: CRLF, a lone LF and no trailing newline all have to survive.
const USER_EDIT = Buffer.from('A\r\nB\nC user edit, no newline');

test('a refused fast-forward restores the user\'s snapshotted edit byte-for-byte and surfaces the git error', async (t) => {
  const { repo, git, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-a', 'A task\nB\nC\n');
  await divergeMain(repo, git);
  const headBefore = git('rev-parse', 'HEAD');
  await fs.writeFile(tracked, USER_EDIT);

  const outcome = await fastForwardMain(repo, 'lattice/edit-a');

  if (outcome.status !== 'error') assert.fail(`the fast-forward must be refused: ${JSON.stringify(outcome)}`);
  assert.ok(
    outcome.message.startsWith('Fast-forward of main to lattice/edit-a failed: '),
    `unexpected message: ${outcome.message}`,
  );
  assert.doesNotMatch(outcome.message, /Snapshot/, 'a clean restore adds no warning');
  assert.equal(git('rev-parse', 'HEAD'), headBefore, 'main did not move');
  assert.deepEqual(await fs.readFile(tracked), USER_EDIT, 'the user\'s edit is back on disk');
  assert.deepEqual(snapshotsOf(repo), [], 'the fully restored snapshot is not left behind');
});

test('a refused fast-forward whose snapshot restore also throws names where the captured edits were kept', async (t) => {
  const { repo, git, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-a', 'A task\nB\nC\n');
  await divergeMain(repo, git);
  await fs.writeFile(tracked, USER_EDIT);

  // restoreSnapshot runs under the project mutation lock. Fail that lock's
  // acquisition once a snapshot exists — i.e. for the restore, not the
  // capture — so restoreSnapshot itself throws.
  const lockDir = path.dirname(projectRunLockFilePath(canonicalProjectPath(repo)));
  const mkdir = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (path.resolve(String(args[0])) === path.resolve(lockDir) && snapshotsOf(repo).length > 0) {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${lockDir}'`), { code: 'EACCES' });
    }
    return mkdir(...args);
  });
  t.mock.method(console, 'warn', () => {});

  const outcome = await fastForwardMain(repo, 'lattice/edit-a');

  if (outcome.status !== 'error') assert.fail(`the fast-forward must be refused: ${JSON.stringify(outcome)}`);
  const [snapshotDir, ...others] = snapshotsOf(repo);
  assert.ok(snapshotDir, 'the snapshot is retained');
  assert.deepEqual(others, []);
  assert.ok(
    outcome.message.startsWith('Fast-forward of main to lattice/edit-a failed: '),
    `unexpected message: ${outcome.message}`,
  );
  assert.ok(
    outcome.message.includes(`(Snapshot restore failed; captured versions retained at ${snapshotDir}: `),
    `the message must point at the retained snapshot: ${outcome.message}`,
  );
  assert.match(outcome.message, /EACCES/);
  // The edit is not on disk (the capture reset it) — but it is intact where
  // the message says.
  assert.equal(await fs.readFile(tracked, 'utf8'), BASE);
  assert.deepEqual(await fs.readFile(path.join(snapshotDir, 'tracked.txt')), USER_EDIT);
});

test('fastForwardMain bails on a missing .git before running any further git', async (t) => {
  const { repo, taskBranch, tracked } = await repoFixture(t);
  await taskBranch('lattice/edit-a', 'A task\nB\nC\n');
  await fs.writeFile(tracked, USER_EDIT);
  await fs.rename(path.join(repo, '.git'), path.join(repo, '.git-moved'));

  const outcome = await fastForwardMain(repo, 'lattice/edit-a');

  if (outcome.status !== 'error') assert.fail(`expected an error: ${JSON.stringify(outcome)}`);
  assert.ok(
    outcome.message.startsWith(`Cannot fast-forward: ${repo}/.git is missing.`),
    `unexpected message: ${outcome.message}`,
  );
  // Nothing past the preflight ran: no snapshot was captured and the dirty
  // file was neither reset nor rewritten.
  assert.deepEqual(snapshotsOf(repo), []);
  assert.deepEqual(await fs.readFile(tracked), USER_EDIT);
  await assert.rejects(fs.access(path.join(repo, '.git')), { code: 'ENOENT' }, 'no git command recreated .git');
});
