// Uncommitted-changes banner for workflow planning steps
// (workflowRuns/projectDirtyState.ts).
//
// `renderDirtyStateWarning(getProjectDirtyState(project))` is the banner at the
// top of every planning step's WORKFLOW_STEP.md. It is the only thing that
// stops a planner from filing tasks against paths that exist on disk but not
// in HEAD — tasks the executors then reject as hallucinations.
//
// The parser slices porcelain v1 lines by column (`line[0]`, `line[1]`,
// `line.slice(3)`). An off-by-one, a trimmed first line (` M a.txt` would
// lose its leading space and report `.txt`), or a misclassified status
// silently corrupts the list, or drops the banner by returning `null`.
// Real temp repos throughout; HOME is isolated, so the identity is set on each
// temp repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTempDir, writeLayout } from './helpers/tempDir.js';
import {
  getProjectDirtyState,
  renderDirtyStateWarning,
  type DirtyStateSummary,
} from '../workflowRuns/projectDirtyState.js';

const PREFIX = 'lattice-dirty-state-';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Identity per repo (HOME is isolated); autocrlf off so Git for Windows' system
// config can't add CRLF noise to the status.
async function initRepo(repo: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await writeLayout(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
}

const sorted = (xs: string[]) => [...xs].sort();

test('getProjectDirtyState: a non-git directory is null', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const plain = path.join(dir, 'plain');
    await writeLayout(plain, { 'a.txt': 'a\n' });
    // Keep git from walking up into whatever repo might enclose the temp dir.
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      assert.equal(await getProjectDirtyState(plain), null);
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });
});

test('getProjectDirtyState: a clean repo is null', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const repo = path.join(dir, 'repo');
    await initRepo(repo, { 'a.txt': 'a\n', 'src/b.txt': 'b\n' });
    assert.equal(await getProjectDirtyState(repo), null);
  });
});

test('getProjectDirtyState: classifies every porcelain shape, first line ` M` keeps its full path', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const repo = path.join(dir, 'repo');
    await initRepo(repo, {
      'a.txt': 'a\n',
      'b-staged.txt': 'b\n',
      'c-mm.txt': 'c\n',
      'd-wtdel.txt': 'd\n',
      'e-idxdel.txt': 'e\n',
      'old.txt': 'a file with enough content for rename detection\n',
    });

    // ` M` — worktree-only; `a.txt` sorts first, so this is porcelain line 1.
    await writeLayout(repo, { 'a.txt': 'a changed\n' });
    // `M ` — staged modification.
    await writeLayout(repo, { 'b-staged.txt': 'b changed\n' });
    git(repo, ['add', 'b-staged.txt']);
    // `MM` — staged, then modified again.
    await writeLayout(repo, { 'c-mm.txt': 'c staged\n' });
    git(repo, ['add', 'c-mm.txt']);
    await writeLayout(repo, { 'c-mm.txt': 'c staged then edited\n' });
    // ` D` — deleted on disk only.
    await fs.rm(path.join(repo, 'd-wtdel.txt'));
    // `D ` — staged delete.
    git(repo, ['rm', '-q', 'e-idxdel.txt']);
    // `AD` — added, then deleted from the worktree.
    await writeLayout(repo, { 'f-added.txt': 'f\n' });
    git(repo, ['add', 'f-added.txt']);
    await fs.rm(path.join(repo, 'f-added.txt'));
    // `R ` — staged rename.
    git(repo, ['mv', 'old.txt', 'renamed.txt']);
    // `??` — untracked file inside a brand-new directory (-uall lists the file).
    await writeLayout(repo, { 'newdir/sub/deep.txt': 'deep\n' });

    // Pin the fixture: the first raw porcelain line really has a leading space.
    const firstLine = git(repo, ['status', '--porcelain=v1', '-uall']).split(/\r?\n/)[0];
    assert.equal(firstLine, ' M a.txt');

    const dirty = await getProjectDirtyState(repo);
    assert.ok(dirty, 'a dirty repo must produce a summary');
    assert.equal(dirty.modified[0], 'a.txt');
    assert.ok(!dirty.modified.includes('.txt') && !dirty.modified.includes(' a.txt'));
    assert.deepEqual(
      sorted(dirty.modified),
      sorted(['a.txt', 'b-staged.txt', 'c-mm.txt', 'old.txt -> renamed.txt']),
    );
    assert.deepEqual(
      sorted(dirty.deleted),
      sorted(['d-wtdel.txt', 'e-idxdel.txt', 'f-added.txt']),
    );
    assert.deepEqual(dirty.untracked, ['newdir/sub/deep.txt']);
  });
});

test('getProjectDirtyState: called from a subdirectory, paths stay repo-root-relative', async () => {
  await withTempDir(PREFIX, async (dir) => {
    const repo = path.join(dir, 'repo');
    await initRepo(repo, { 'top.txt': 'top\n', 'pkg/inner.txt': 'inner\n' });
    await writeLayout(repo, { 'top.txt': 'top changed\n', 'pkg/inner.txt': 'inner changed\n' });
    await fs.rm(path.join(repo, 'pkg', 'inner.txt'));
    await writeLayout(repo, { 'pkg/new/file.txt': 'new\n', 'other/untracked.txt': 'u\n' });

    const dirty = await getProjectDirtyState(path.join(repo, 'pkg'));
    assert.deepEqual(dirty, {
      modified: ['top.txt'],
      deleted: ['pkg/inner.txt'],
      untracked: sorted(['other/untracked.txt', 'pkg/new/file.txt']),
    });
  });
});

// ── renderDirtyStateWarning (pure) ─────────────────────────────────────────

function fencedBlock(md: string): string[] {
  const lines = md.split('\n');
  const open = lines.indexOf('```');
  assert.ok(open >= 0, 'rendered warning must contain a fenced block');
  const close = lines.indexOf('```', open + 1);
  assert.ok(close > open, 'fenced block must be closed');
  return lines.slice(open + 1, close);
}

const names = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}.ts`);

test('renderDirtyStateWarning: heading, totals line, and deleted → untracked → modified order', () => {
  const dirty: DirtyStateSummary = {
    modified: ['m1.ts', 'm2.ts'],
    deleted: ['d1.ts'],
    untracked: ['u1.ts', 'u2.ts', 'u3.ts'],
  };
  const md = renderDirtyStateWarning(dirty);
  const lines = md.split('\n');

  assert.equal(
    lines[0],
    '## ⚠ Project working tree has uncommitted changes — read this before planning',
  );
  assert.ok(
    md.includes('**2 modified, 1 deleted, 3 untracked** path(s) (6 total).'),
    'totals line must name each count and the total',
  );
  assert.ok(lines.includes('Diverged paths (6 of 6):'));
  assert.deepEqual(fencedBlock(md), [
    'D  d1.ts',
    '?? u1.ts',
    '?? u2.ts',
    '?? u3.ts',
    'M  m1.ts',
    'M  m2.ts',
  ]);
  assert.ok(!md.includes('omitted'));
  assert.ok(!md.includes('... and'));
});

test('renderDirtyStateWarning: more than 25 paths caps the sample and names the omission', () => {
  const dirty: DirtyStateSummary = {
    modified: names('m', 10),
    deleted: names('d', 10),
    untracked: names('u', 10),
  };
  const md = renderDirtyStateWarning(dirty);

  assert.ok(md.includes('**10 modified, 10 deleted, 10 untracked** path(s) (30 total).'));
  assert.ok(md.split('\n').includes('Diverged paths (25 of 30, 5 omitted):'));
  const block = fencedBlock(md);
  assert.equal(block.length, 26);
  assert.deepEqual(block.slice(0, 25), [
    ...dirty.deleted.map((p) => `D  ${p}`),
    ...dirty.untracked.map((p) => `?? ${p}`),
    ...dirty.modified.slice(0, 5).map((p) => `M  ${p}`),
  ]);
  assert.equal(block[25], '... and 5 more');
});

test('renderDirtyStateWarning: exactly 25 paths is not capped', () => {
  const dirty: DirtyStateSummary = {
    modified: names('m', 5),
    deleted: names('d', 10),
    untracked: names('u', 10),
  };
  const md = renderDirtyStateWarning(dirty);

  assert.ok(md.split('\n').includes('Diverged paths (25 of 25):'));
  const block = fencedBlock(md);
  assert.equal(block.length, 25);
  assert.equal(block[24], `M  ${dirty.modified[4]}`);
  assert.ok(!md.includes('omitted'));
  assert.ok(!md.includes('... and'));
});
