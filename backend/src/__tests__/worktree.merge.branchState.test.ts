import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBranchState,
  emptyBranchOutcome,
  type BranchStateDeps,
} from '../worktree/merge/branchState.js';

// checkBranchState classifies whether a ready-to-merge branch should merge, be
// cleaned up, or error. It reads exactly two git facts — branchCommitCount()
// and branchIsAncestorOfHead() from ../state.js. Those hit the disposable
// worktree via `exec`, so to stay a pure unit test we inject stubs through the
// module's injectable `deps` seam (the same DI idiom finalizeResolved.ts /
// decideInProgressComplete use) rather than spawning git.
//
// The safety-critical invariant (branchState.ts source comment): if
// branchCommitCount THROWS (transient git failure / timeout / spawn error) the
// result must be {kind:'error'} — NOT be misread as an empty / already-merged
// branch, which would SILENTLY DROP the merge and lose the user's committed
// work. All four discriminated outcomes are exercised below.

const BRANCH = 'lattice/example-abc123';

// Build a deps object from spies so each case can both stub behavior and assert
// which reads were (not) consulted — the short-circuits are part of the guard.
// Return the spies alongside the deps so call counts stay typed as Mocks.
function makeDeps(over: {
  count?: BranchStateDeps['branchCommitCount'];
  ancestor?: BranchStateDeps['branchIsAncestorOfHead'];
}) {
  const branchCommitCount = mock.fn(over.count ?? (async () => 0));
  const branchIsAncestorOfHead = mock.fn(over.ancestor ?? (async () => false));
  const deps: BranchStateDeps = { branchCommitCount, branchIsAncestorOfHead };
  return { deps, branchCommitCount, branchIsAncestorOfHead };
}

test('branchCommitCount throwing yields {kind:"error"} and does NOT consult the ancestor check', async () => {
  const { deps, branchIsAncestorOfHead } = makeDeps({
    count: async () => {
      throw new Error('index.lock: unable to count commits');
    },
    // If this were consulted it would (wrongly) let a transient failure be
    // reclassified — so we assert callCount() === 0 below.
    ancestor: async () => true,
  });

  const res = await checkBranchState('/repo', BRANCH, deps);

  assert.equal(res.kind, 'error');
  if (res.kind !== 'error') return; // narrow for TS
  assert.equal(res.outcome.status, 'error');
  // The error message must reflect the count failure AND name the branch so
  // the caller can report it (and it carries the underlying git error).
  assert.match(res.outcome.message, /count commits/i);
  assert.ok(
    res.outcome.message.includes(BRANCH),
    `error message should mention the branch, got: ${res.outcome.message}`,
  );
  assert.match(res.outcome.message, /index\.lock/);
  // A git failure is surfaced BEFORE the ancestor check runs — never misread
  // as an empty/already-merged branch.
  assert.equal(branchIsAncestorOfHead.mock.callCount(), 0);
});

test('0 commits + ancestor-of-HEAD yields {kind:"already-merged"}', async () => {
  const { deps, branchIsAncestorOfHead } = makeDeps({
    count: async () => 0,
    ancestor: async () => true,
  });

  const res = await checkBranchState('/repo', BRANCH, deps);

  assert.deepEqual(res, { kind: 'already-merged' });
  assert.equal(branchIsAncestorOfHead.mock.callCount(), 1);
});

test('0 commits + NOT ancestor-of-HEAD yields {kind:"empty"}', async () => {
  const { deps } = makeDeps({
    count: async () => 0,
    ancestor: async () => false,
  });

  const res = await checkBranchState('/repo', BRANCH, deps);

  assert.deepEqual(res, { kind: 'empty' });
});

test('a positive commit count yields {kind:"ahead", commits:N} and short-circuits the ancestor check', async () => {
  const { deps, branchIsAncestorOfHead } = makeDeps({
    count: async () => 3,
    ancestor: async () => true, // must not be consulted
  });

  const res = await checkBranchState('/repo', BRANCH, deps);

  assert.deepEqual(res, { kind: 'ahead', commits: 3 });
  // commits > 0 short-circuits — the ancestor check is never needed.
  assert.equal(branchIsAncestorOfHead.mock.callCount(), 0);
});

test('emptyBranchOutcome returns a status:"error" MergeOutcome naming the branch', () => {
  const outcome = emptyBranchOutcome(BRANCH);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.status === 'error' && outcome.message.includes(BRANCH), true);
});
