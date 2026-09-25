import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { addWorktreeWithRetries, WORKTREE_ADD_TIMEOUT_MS } from '../worktree/setupAdd.js';
import { withCheckoutSlot } from '../worktree/checkoutGate.js';
import type { ExecOptions, ExecResult } from '../worktree/exec.js';
import type { WorktreeCandidatePlan } from '../worktree/setupCandidates.js';

// Regression: `git worktree add` ran with no timeout inside one of the two
// machine-wide checkout slots, so two hung post-checkout hooks / LFS smudges
// held both slots forever and every later task start waited behind them.
test('a timed-out worktree add is bounded, throws, cleans up and frees its checkout slot', async () => {
  const worktreesDir = path.resolve('/lattice-home/worktrees/abc');
  const plan: WorktreeCandidatePlan = {
    slug: 'hang',
    shortId: 'x1',
    worktreesDir,
    candidates: [0, 1, 2].map((attempt) => ({
      attempt,
      suffix: attempt ? `-r${attempt + 1}` : '',
      candidatePath: path.join(worktreesDir, `hang-x1${attempt ? `-r${attempt + 1}` : ''}`),
      candidateBranch: `lattice/hang-x1${attempt ? `-r${attempt + 1}` : ''}`,
    })),
  };
  const addCalls: ExecOptions[] = [];
  const reconciled: string[] = [];
  const stubGit = async (_repo: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    if (args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '', code: 0 };
    assert.deepEqual(args.slice(0, 2), ['worktree', 'add']);
    addCalls.push(opts ?? {});
    return { stdout: '', stderr: `\n[exec] killed after ${opts?.timeoutMs}ms timeout`, code: 124 };
  };
  const run = () =>
    withCheckoutSlot(() =>
      addWorktreeWithRetries('/repo', plan, 'hang task', { GIT_LFS_SKIP_SMUDGE: '1' }, {
        projectGit: stubGit,
        reconcile: async (_repo, _branch, candidatePath) => {
          reconciled.push(candidatePath);
          return true;
        },
      }),
    );

  // Two timed-out adds occupy both slots; a third checkout queues behind them.
  const first = run();
  const second = run();
  let thirdRan = false;
  const third = withCheckoutSlot(async () => {
    thirdRan = true;
  });

  await assert.rejects(first, /timed out/);
  await assert.rejects(second, /timed out/);
  await third;
  assert.equal(thirdRan, true, 'a queued checkout must run once the timed-out adds free their slots');

  // Each add was bounded (and kept its LFS env); a timeout does not retry the
  // other suffixes, which would just hang again.
  assert.equal(addCalls.length, 2);
  for (const opts of addCalls) {
    assert.equal(opts.timeoutMs, WORKTREE_ADD_TIMEOUT_MS);
    assert.deepEqual(opts.env, { GIT_LFS_SKIP_SMUDGE: '1' });
  }
  // The partial candidate went back through reconcile (once before the add,
  // once to clean up after the timeout).
  assert.deepEqual(reconciled, [
    plan.candidates[0].candidatePath,
    plan.candidates[0].candidatePath,
    plan.candidates[0].candidatePath,
    plan.candidates[0].candidatePath,
  ]);
});
