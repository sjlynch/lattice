import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  isLatticeEphemeralProjectKey,
  selectStaleEphemeralProjectKeys,
} from '../claudeTrust.js';

// Build paths under the real `~/.lattice/` so the predicate's home-match works
// on any platform/home without mocking os.homedir().
const HOME_LATTICE = path.join(os.homedir(), '.lattice');
const homeWorktree = path.join(HOME_LATTICE, 'worktrees', 'abc123def456', 'fix-thing-q1z2');
const homePush = path.join(HOME_LATTICE, 'per-project', 'abc123def456', 'push', 'push_1_aa');
const homeQa = path.join(HOME_LATTICE, 'per-project', 'abc123def456', 'qa', 'qa_1_bb');
const homePostMerge = path.join(
  HOME_LATTICE,
  'per-project',
  'abc123def456',
  'post-merge-hooks',
  'pmh_1_cc',
);

test('isLatticeEphemeralProjectKey: matches home-scoped worktree + scratch cwds', () => {
  assert.equal(isLatticeEphemeralProjectKey(homeWorktree), true);
  assert.equal(isLatticeEphemeralProjectKey(homePush), true);
  assert.equal(isLatticeEphemeralProjectKey(homeQa), true);
  assert.equal(isLatticeEphemeralProjectKey(homePostMerge), true);
  // Claude keys are forward-slashed even on Windows — must still match.
  assert.equal(isLatticeEphemeralProjectKey(homeWorktree.replace(/\\/g, '/')), true);
});

test('isLatticeEphemeralProjectKey: matches legacy in-repo worktrees', () => {
  assert.equal(
    isLatticeEphemeralProjectKey('C:/development/lattice/.lattice/worktrees/slug-x1'),
    true,
  );
  assert.equal(
    isLatticeEphemeralProjectKey('/home/u/repo/.lattice/worktrees/slug-x1'),
    true,
  );
});

test('isLatticeEphemeralProjectKey: never matches real project roots / siblings', () => {
  // The user's actual repo — written by the project-instrumentation reconcile.
  assert.equal(isLatticeEphemeralProjectKey('C:/development/lattice'), false);
  assert.equal(isLatticeEphemeralProjectKey('/home/u/projects/myrepo'), false);
  // The home dir and the ~/.lattice root itself are not "under" ~/.lattice/.
  assert.equal(isLatticeEphemeralProjectKey(os.homedir()), false);
  assert.equal(isLatticeEphemeralProjectKey(HOME_LATTICE), false);
  // A sibling that merely shares the `.lattice` prefix must not match (the
  // `home + '/'` boundary, not bare `home`).
  assert.equal(isLatticeEphemeralProjectKey(`${HOME_LATTICE}-backups/x`), false);
  // `.lattice` without the `worktrees` segment in a repo is not a worktree cwd.
  assert.equal(isLatticeEphemeralProjectKey('/home/u/repo/.lattice/workflows.json'), false);
});

test('selectStaleEphemeralProjectKeys: prunes ephemeral keys whose dir is gone, keeps live + real', async () => {
  const liveWorktree = path.join(HOME_LATTICE, 'worktrees', 'abc123def456', 'still-running-w9');
  const realProject = 'C:/development/lattice';
  const present = new Set([liveWorktree, realProject]); // exist on disk
  const dirExists = async (p: string) => present.has(p);

  const stale = await selectStaleEphemeralProjectKeys(
    [homeWorktree, homePush, liveWorktree, realProject],
    dirExists,
  );

  // Dead ephemeral cwds pruned; the live worktree (dir present) and the real
  // project root (not ephemeral) are both kept.
  assert.deepEqual(stale.sort(), [homePush, homeWorktree].sort());
});

test('selectStaleEphemeralProjectKeys: empty when nothing is ephemeral', async () => {
  const stale = await selectStaleEphemeralProjectKeys(
    ['C:/development/lattice', '/home/u/projects/other'],
    async () => false,
  );
  assert.deepEqual(stale, []);
});
