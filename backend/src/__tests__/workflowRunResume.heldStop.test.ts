// A Claude step's Stop that the quiescence gate was holding when the backend
// died. The gate is an in-memory timer, so the Stop is recorded on the run
// (mirrored to disk) and a re-adopting backend re-arms the gate; these pin the
// quiet-window arithmetic across the restart — counted from the held Stop,
// from boot when the gate last saw the session busy (downtime is not
// silence), never busy for the boot placeholder signal — and that a gate
// holding a Stop for live subagents persists that busy observation. Each
// case's regression story is beside it. Shared fixture:
// helpers/workflowRunResume.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreWorkflowRun } from '../workflowRuns.js';
import { runs } from '../workflowRuns/state.js';
import {
  flushWorkflowRunPersist,
  loadPersistedWorkflowRuns,
} from '../workflowRuns/persistence.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';
import { createWorkflow } from '../workflows.js';
import { fakeRun } from './helpers/workflowRunResume.js';

// Regression (self-hosting soak, 2026-09-25): a Claude step's Stop arrived and
// was ACCEPTED (200, `gated: true`) while the quiescence gate waited out its
// settle window — then the backend restarted. The gate is an in-memory timer,
// the hook never retries an answered callback, and the agent sat idle, so the
// step never advanced (a Run tests step until its 60-min timeout, an agent step
// forever). The Stop is now recorded on the run and a re-adopting backend
// re-arms the gate, counting the quiet window from the Stop itself.
test('a Stop the gate was holding when the backend died still advances the re-adopted run', async () => {
  const { recordStopReceived } = await import('../workflowRuns/stopHookGate.js');
  const { registerPersistedWorkflowRuns, resumePersistedRun } = await import('../recovery/workflowRunResume.js');
  const { READOPTED_SETTLE_MS } = await import('../agentQuiescence.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfstop-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'Refactor', [
      { id: 's1', title: 'Plan', prompt: 'a', mode: 'sequential', harness: 'claude' },
      { id: 's2', title: 'Review', prompt: 'b', mode: 'sequential', harness: 'claude' },
    ]);
    canonical = wf.projectPath;
    const live = fakeRun({
      id: 'wfrun_stop_held',
      workflowId: wf.id,
      workflowName: wf.name,
      projectPath: wf.projectPath,
      totalSteps: 2,
      currentStepIndex: 1,
      stepPhase: 'running',
    });
    assert.equal(restoreWorkflowRun(live), true);

    // The Stop lands: recorded durably before the hook gets its answer.
    await recordStopReceived(live.id, 1);
    await flushWorkflowRunPersist(wf.projectPath);

    // The backend dies inside the settle window (the in-memory gate with it).
    runs.delete(live.id);
    const [fromDisk] = await loadPersistedWorkflowRuns(wf.projectPath);
    assert.equal(fromDisk?.stopReceived?.stepIndex, 1, 'the held Stop must survive on disk');
    // Pretend the Stop was long enough ago that even the re-adopted window has
    // passed, so the test needn't wait two minutes.
    fromDisk.stopReceived!.at = Date.now() - READOPTED_SETTLE_MS - 5_000;

    // Boot: the step's pty survived in the terminal-server.
    const sessions = [{ id: 'tty_step1', cwd: workflowStepDir(wf.projectPath, live.id, 1) }];
    registerPersistedWorkflowRuns([fromDisk], sessions);
    await resumePersistedRun(fromDisk, sessions, 'http://127.0.0.1:1', true);

    // No second Stop is coming — the re-armed gate alone must finish the step.
    const deadline = Date.now() + 8_000;
    while (runs.get(live.id)?.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(runs.get(live.id)?.status, 'completed');
  } finally {
    for (const [id, r] of [...runs.entries()]) {
      if (r.projectPath === canonical) runs.delete(id);
    }
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('markAgentReadopted counts a held Stop\'s quiet window from the Stop, and is idempotent', async () => {
  const q = await import('../agentQuiescence.js');
  const old = Date.now() - q.READOPTED_SETTLE_MS - 1_000;
  q.markAgentReadopted('wf:test-readopt:0', { stopAt: old });
  assert.equal(q.isAgentQuiescent('wf:test-readopt:0', 4_000), true, 'quiet since the Stop, long enough');
  // The resume pass marks again without a time — it must not reset the clock.
  q.markAgentReadopted('wf:test-readopt:0');
  assert.equal(q.isAgentQuiescent('wf:test-readopt:0', 4_000), true);
  // A fresh re-adopt with no held Stop starts the long window now.
  q.markAgentReadopted('wf:test-readopt:1');
  assert.equal(q.isAgentQuiescent('wf:test-readopt:1', 4_000), false);
  // The old gate was HOLDING that Stop because the session was busy (live
  // subagents) right up to the restart: the window counts from that, not the
  // Stop, so the step is not advanced — and its pty killed — at boot.
  q.markAgentReadopted('wf:test-readopt:2', { stopAt: old, activeAt: Date.now() - 5_000 });
  assert.equal(q.isAgentQuiescent('wf:test-readopt:2', 4_000), false, 'busy at the restart → the full window again');
  q.forgetAgentQuiescence('wf:test-readopt:0');
  q.forgetAgentQuiescence('wf:test-readopt:1');
  q.forgetAgentQuiescence('wf:test-readopt:2');
});

// Regression: a gate holding a Stop for busy subagents, then a backend down for
// longer than READOPTED_SETTLE_MS. No hook could be delivered while it was
// down, so the downtime is not silence — the quiet window starts at boot, not
// at the persisted `activeAt` (which would advance, and kill the pty, ~1 s
// after boot while the subagents still work).
test('markAgentReadopted starts a busy held Stop\'s quiet window at boot, not at activeAt', async () => {
  const q = await import('../agentQuiescence.js');
  const realNow = Date.now;
  const T = realNow();
  let now = T + 300_000;
  Date.now = () => now;
  try {
    // A pre-`busy` record: an `activeAt` alone means the gate saw it active.
    q.markAgentReadopted('wf:test-readopt-busy:0', { stopAt: T, activeAt: T + 10_000 });
    // The explicit flag.
    q.markAgentReadopted('wf:test-readopt-busy:1', { stopAt: T, activeAt: T + 10_000, busy: true });
    // Not busy at the last checkpoint: counts from activeAt as before.
    q.markAgentReadopted('wf:test-readopt-busy:2', { stopAt: T, activeAt: T + 10_000, busy: false });
    for (const id of ['wf:test-readopt-busy:0', 'wf:test-readopt-busy:1']) {
      assert.equal(q.isAgentQuiescent(id, 4_000), false, `${id}: busy at death → not quiescent at boot`);
    }
    assert.equal(q.isAgentQuiescent('wf:test-readopt-busy:2', 4_000), true, 'quiet at death → the downtime counts');

    now = T + 300_000 + q.READOPTED_SETTLE_MS - 1;
    assert.equal(q.isAgentQuiescent('wf:test-readopt-busy:1', 4_000), false, 'still inside the window from boot');
    now = T + 300_000 + q.READOPTED_SETTLE_MS;
    assert.equal(q.isAgentQuiescent('wf:test-readopt-busy:0', 4_000), true, 'quiescent once the window from boot elapses');
    assert.equal(q.isAgentQuiescent('wf:test-readopt-busy:1', 4_000), true);
  } finally {
    Date.now = realNow;
    for (let i = 0; i < 3; i++) q.forgetAgentQuiescence(`wf:test-readopt-busy:${i}`);
  }
});

// The `busy` a holding gate persists: live subagents / a real recent signal
// are busy; the placeholder signal a boot re-adoption sets is not — otherwise
// every boot would re-persist "busy", and restarts closer together than the
// settle window would hold a finished step forever.
test('agentHeldActivity reports busy for real activity, never for the boot placeholder', async () => {
  const q = await import('../agentQuiescence.js');
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const id = 'wf:test-held-activity:0';
  try {
    q.markAgentReadopted(id, { stopAt: now - 400_000, activeAt: now - 390_000 });
    const boot = now;
    now += 1_000;
    assert.deepEqual(q.agentHeldActivity(id, 15_000), { activeAt: boot, busy: false }, 'boot placeholder is not activity');

    q.noteAgentSignal(id); // a surviving subagent's tool use
    assert.deepEqual(q.agentHeldActivity(id, 15_000), { activeAt: now, busy: true }, 'a real signal within the throttle');
    now += 15_000;
    assert.equal(q.agentHeldActivity(id, 15_000).busy, false, 'and not once it is older than the throttle');

    q.noteSubagentStart(id, 'explore-1');
    now += 60_000;
    assert.deepEqual(q.agentHeldActivity(id, 15_000), { activeAt: now, busy: true }, 'a live subagent is busy however quiet');
  } finally {
    Date.now = realNow;
    q.forgetAgentQuiescence(id);
  }
});

test('a gate holding a Stop for live subagents persists when it last saw them busy', async () => {
  const { recordStopReceived, requestStopHookStepComplete } = await import('../workflowRuns/stopHookGate.js');
  const q = await import('../agentQuiescence.js');
  const { workflowStepAgentId } = await import('../workflowRuns/sessionSpawner.js');
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-wfheld-'));
  let canonical = '';
  try {
    const wf = await createWorkflow(project, 'Held', [
      { id: 's1', title: 'Plan', prompt: 'a', mode: 'sequential', harness: 'claude' },
    ]);
    canonical = wf.projectPath;
    const live = fakeRun({ id: 'wfrun_held_busy', workflowId: wf.id, projectPath: wf.projectPath, totalSteps: 1, currentStepIndex: 0, stepPhase: 'running' });
    assert.equal(restoreWorkflowRun(live), true);
    const agentId = workflowStepAgentId(live.id, 0);
    q.noteSubagentStart(agentId, 'explore-1');
    await recordStopReceived(live.id, 0);
    const at = runs.get(live.id)!.stopReceived!.at;
    let advanced = 0;
    requestStopHookStepComplete(live.id, 0, () => void advanced++, { settleMs: 50, pollMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(advanced, 0, 'a live subagent holds the gate');
    const held = runs.get(live.id)!.stopReceived!;
    assert.ok((held.activeAt ?? 0) >= at, 'the busy observation is recorded on the run');
    await flushWorkflowRunPersist(wf.projectPath);
    const [fromDisk] = await loadPersistedWorkflowRuns(wf.projectPath);
    assert.equal(fromDisk?.stopReceived?.activeAt, held.activeAt, 'and persisted for a restart');
    assert.equal(held.busy, true, 'a live subagent marks the checkpoint busy');
    assert.equal(fromDisk?.stopReceived?.busy, true, 'and the busy flag survives the mirror');
    q.forgetAgentQuiescence(agentId);
  } finally {
    for (const [id, r] of [...runs.entries()]) if (r.projectPath === canonical) runs.delete(id);
    await new Promise((r) => setTimeout(r, 200));
    await fs.rm(project, { recursive: true, force: true });
  }
});
