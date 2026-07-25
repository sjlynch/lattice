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

    // Subagent finishes → after the settle window the hook finishes, once.
    noteSubagentStop(agentId);
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
