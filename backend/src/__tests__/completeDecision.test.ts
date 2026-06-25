import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideInProgressComplete } from '../routes/tasks/hooks/complete.js';

// `decideInProgressComplete` is the pure core of the in_progress →
// ready_to_merge decision in POST /api/tasks/:id/complete. The regression it
// guards: a transient git failure while counting branch commits used to be
// swallowed as `0` by `branchCommitCount`/`countBetween`, so a finished agent
// whose branch carried real commits was reported as "no commits" and silently
// stranded at in_progress (the Stop hook fires exactly once, so there's no
// retry). The fix makes the count throw on a git error and treats that error
// case separately from a genuine zero.

test('decideInProgressComplete: a git error does NOT strand the task at in_progress', async () => {
  // Stub the commit count to signal a git error (a non-empty branch whose
  // count momentarily failed). The decision must be to flip — NOT awaiting.
  const decision = await decideInProgressComplete(async () => {
    throw new Error('git rev-list --count HEAD..lattice/foo failed: index.lock');
  });
  assert.equal(decision, 'flip');
});

test('decideInProgressComplete: a real zero count still leaves the task at in_progress', async () => {
  // Claude finished a turn without committing — a genuine empty branch must
  // stay at in_progress (awaiting a commit), unchanged from the original guard.
  const decision = await decideInProgressComplete(async () => 0);
  assert.equal(decision, 'awaiting-commit');
});

test('decideInProgressComplete: a positive count flips to ready_to_merge', async () => {
  assert.equal(await decideInProgressComplete(async () => 1), 'flip');
  assert.equal(await decideInProgressComplete(async () => 7), 'flip');
});
