import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  forgetAgentQuiescence,
  noteAgentSignal,
  noteSubagentStart,
  noteSubagentStop,
} from '../agentQuiescence.js';
import {
  cancelPostMergeHookStopGate,
  requestPostMergeHookStopComplete,
} from '../postMergeHooks/stopHookGate.js';
import { postMergeHookAgentId } from '../postMergeHooks/stopHook.js';
import {
  finishPostMergeHook,
  recordPostMergeHook,
} from '../postMergeHooks/registry.js';
import type { PostMergeHookRun } from '../postMergeHooks/types.js';

// Regression for: "post-merge hook /complete is not quiescence-gated." Claude's
// Stop hook fires early/repeatedly when the hook agent uses subagents, so the
// Stop-hook-sourced /complete callback must NOT finish the hook until the
// session is quiescent — otherwise the merge run reports completed (and a queued
// workflow's next step dispatches) on top of a still-working post-merge agent.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seedRunningHook(id: string): void {
  const run: PostMergeHookRun = {
    id,
    projectPath: path.join(os.tmpdir(), `lattice-pmh-gate-${process.pid}`),
    harness: 'claude',
    prompt: 'test',
    cwd: path.join(os.tmpdir(), id),
    status: 'running',
    startedAt: Date.now(),
    trigger: 'manual-merge',
  };
  recordPostMergeHook(run);
}

test('a premature post-merge Stop while a subagent is live does not finish until quiescent', async () => {
  const id = `pmh_gate_premature_${Date.now()}`;
  const agentId = postMergeHookAgentId(id);
  let finished = 0;
  try {
    seedRunningHook(id);
    // A subagent is in flight — this is the exact premature-Stop scenario.
    noteSubagentStart(agentId);
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 40, pollMs: 10 });

    // While the subagent is live, no amount of waiting finishes the hook.
    await sleep(120);
    assert.equal(finished, 0, 'must not finish while a subagent is still running');

    // Subagent finishes → the parent's next turn must end (a later Stop).
    noteSubagentStop(agentId);
    await sleep(120);
    assert.equal(finished, 0, 'a finished subagent wakes its parent: wait for its Stop');
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(160);
    assert.equal(finished, 1, 'finishes once the session goes quiescent');
  } finally {
    cancelPostMergeHookStopGate(id);
    forgetAgentQuiescence(agentId);
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});

test('repeated/duplicate post-merge Stops finish the hook exactly once', async () => {
  const id = `pmh_gate_dup_${Date.now()}`;
  const agentId = postMergeHookAgentId(id);
  let finished = 0;
  try {
    seedRunningHook(id);
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(15);
    // A second Stop fire extends the window but starts no second poll loop.
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(160);
    assert.equal(finished, 1, 'exactly one finish despite two Stop fires');
  } finally {
    cancelPostMergeHookStopGate(id);
    forgetAgentQuiescence(agentId);
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});

test('a Stop for an already-finished hook never finishes again', async () => {
  const id = `pmh_gate_finished_${Date.now()}`;
  const agentId = postMergeHookAgentId(id);
  let finished = 0;
  try {
    seedRunningHook(id);
    // The hook already reached a terminal status (e.g. the model's explicit
    // curl landed first); a straggler Stop must not resurrect it.
    finishPostMergeHook(id, 'completed');
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 20, pollMs: 5 });
    await sleep(80);
    assert.equal(finished, 0, 'a Stop for a non-running hook never finishes');
  } finally {
    cancelPostMergeHookStopGate(id);
    forgetAgentQuiescence(agentId);
  }
});

test('cancelPostMergeHookStopGate stops a pending finish', async () => {
  const id = `pmh_gate_cancel_${Date.now()}`;
  const agentId = postMergeHookAgentId(id);
  let finished = 0;
  try {
    seedRunningHook(id);
    requestPostMergeHookStopComplete(id, () => { finished += 1; }, { settleMs: 40, pollMs: 10 });
    await sleep(15);
    cancelPostMergeHookStopGate(id);
    await sleep(120);
    assert.equal(finished, 0, 'a cancelled gate never fires its finish');
  } finally {
    cancelPostMergeHookStopGate(id);
    forgetAgentQuiescence(agentId);
    finishPostMergeHook(id, 'aborted', 'test cleanup');
  }
});

// Regression (self-hosting soak, 2026-09-25): a Stop the gate was holding when
// the backend restarted used to be lost — the hook had its 200, so nothing
// retried, and the idle agent never Stops again. The Stop's time is now on the
// record, survives the mirror, and boot recovery re-arms the gate from it.
test('a held Stop survives the mirror and a re-armed gate finishes the re-adopted hook', async () => {
  const { deserializePostMergeHook } = await import('../postMergeHooks/registry.js');
  const { markAgentReadopted, READOPTED_SETTLE_MS } = await import('../agentQuiescence.js');
  const id = 'pmh_1700000000000_abcdef';
  const project = path.join(os.tmpdir(), 'pmh-rearm-project');
  const stopAt = Date.now() - READOPTED_SETTLE_MS - 5_000;
  const back = deserializePostMergeHook(
    { id, status: 'running', harness: 'claude', prompt: 'p', startedAt: 1, trigger: 'merge-run', stopReceivedAt: stopAt },
    project,
  );
  assert.equal(back?.stopReceivedAt, stopAt, 'stopReceivedAt round-trips through the mirror');

  seedRunningHook(id);
  // What boot recovery does for a re-adopted Claude hook with a held Stop.
  markAgentReadopted(postMergeHookAgentId(id), stopAt);
  let finished = 0;
  requestPostMergeHookStopComplete(id, () => void finished++, { settleMs: 4000, pollMs: 10 }, { rearm: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(finished, 1, 'no second Stop needed — the re-armed gate finishes it');
  forgetAgentQuiescence(postMergeHookAgentId(id));
  finishPostMergeHook(id, 'completed');
});
