import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildWorktreeCandidatePlan,
  canonicalWorktreePath,
  slugifyTaskTitle,
} from '../worktree/setupCandidates.js';

test('slugifyTaskTitle preserves setupTaskWorktree branch slug behavior', () => {
  assert.equal(slugifyTaskTitle('Hello, World!'), 'hello-world');
  assert.equal(slugifyTaskTitle('***'), 'task');
  assert.equal(slugifyTaskTitle('a'.repeat(80)), 'a'.repeat(40));
});

test('buildWorktreeCandidatePlan returns canonical then retry suffix sequence', () => {
  const plan = buildWorktreeCandidatePlan(path.resolve('repo'), {
    id: 't_1778801135607_dvtuc',
    title: 'Refactor Worktree Setup!!!',
  });

  assert.equal(plan.slug, 'refactor-worktree-setup');
  assert.equal(plan.shortId, '_dvtuc');
  assert.deepEqual(
    plan.candidates.map((c) => c.suffix),
    ['', '-r2', '-r3', '-r4', '-r5'],
  );
  assert.deepEqual(
    plan.candidates.map((c) => path.basename(c.candidatePath)),
    [
      'refactor-worktree-setup-_dvtuc',
      'refactor-worktree-setup-_dvtuc-r2',
      'refactor-worktree-setup-_dvtuc-r3',
      'refactor-worktree-setup-_dvtuc-r4',
      'refactor-worktree-setup-_dvtuc-r5',
    ],
  );
  assert.deepEqual(
    plan.candidates.map((c) => c.candidateBranch),
    [
      'lattice/refactor-worktree-setup-_dvtuc',
      'lattice/refactor-worktree-setup-_dvtuc-r2',
      'lattice/refactor-worktree-setup-_dvtuc-r3',
      'lattice/refactor-worktree-setup-_dvtuc-r4',
      'lattice/refactor-worktree-setup-_dvtuc-r5',
    ],
  );
  assert.equal(
    canonicalWorktreePath(plan),
    plan.candidates[0].candidatePath,
  );
});
