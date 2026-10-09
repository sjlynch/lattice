// Workflow-run boot recovery: the pure resume policy and finding the step's
// surviving pty. A restarted backend re-adopts a running run from its on-disk
// mirror (the regression story: workflowRunResume.restore.test.ts). These pin
// what each persisted run does at boot: an agent step whose pty survived — or
// whose terminal-server couldn't be asked (`null` is "couldn't ask", never "no
// sessions") — is re-adopted; a pending step with no terminal ever requested
// is re-dispatched even when the probe fails; a gone pty errors instead of
// hanging; control steps are re-run; a finished run is skipped and a
// vanished/shrunk definition errors. The live pty is matched by its step-dir
// cwd, tolerating separator/case drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkflowRunResume,
  findStepSessionId,
} from '../workflowRuns/resumeDecision.js';
import { workflowStepDir } from '../workflowRuns/scratchDirectory.js';

// ---------------------------------------------------------------------------
// The decision policy
// ---------------------------------------------------------------------------

test('classifyWorkflowRunResume: an agent step whose pty survived is re-adopted', () => {
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: true,
  });
  assert.equal(d.action, 'readopt');
});

test('classifyWorkflowRunResume: an unprobeable terminal-server re-adopts, never errors', () => {
  // `null` means "couldn't ask" — NOT "no sessions". Treating it as gone would
  // let one transient probe failure mass-error every healthy run on the box.
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: null,
  });
  assert.equal(d.action, 'readopt');
});

test('classifyWorkflowRunResume: a pending agent step (no terminal ever requested) is redispatched even when the probe fails', () => {
  // A step still inside its pre-run tool (an Opengrep scan) is checkpointed
  // `pending`; nothing exists to re-adopt, and a `null` probe used to park it
  // in readopt with no `/complete` ever coming.
  for (const alive of [null, false] as const) {
    const d = classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 1,
      definitionStepCount: 2,
      stepKind: 'agent',
      stepPhase: 'pending',
      stepSessionAlive: alive,
    });
    assert.equal(d.action, 'redispatch', `alive=${String(alive)}`);
  }
  const live = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 1,
    definitionStepCount: 2,
    stepKind: 'agent',
    stepPhase: 'pending',
    stepSessionAlive: true,
  });
  assert.equal(live.action, 'readopt', 'a positively-alive session is still re-adopted');
});

test('classifyWorkflowRunResume: an agent step whose pty is gone errors instead of hanging', () => {
  const d = classifyWorkflowRunResume({
    status: 'running',
    currentStepIndex: 3,
    definitionStepCount: 7,
    stepKind: 'agent',
    stepSessionAlive: false,
  });
  assert.equal(d.action, 'error');
  assert.match(d.reason, /completion callback can never arrive/);
});

test('classifyWorkflowRunResume: control steps are re-run (they die with the process)', () => {
  for (const kind of ['start', 'merge', 'push'] as const) {
    const d = classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 4,
      definitionStepCount: 7,
      stepKind: kind,
      // Control steps never have a pty; the probe result is irrelevant.
      stepSessionAlive: false,
    });
    assert.equal(d.action, 'redispatch', `${kind} must be re-runnable`);
  }
});

test('classifyWorkflowRunResume: a finished run is skipped, a vanished/shrunk definition errors', () => {
  assert.equal(
    classifyWorkflowRunResume({
      status: 'completed',
      currentStepIndex: 6,
      definitionStepCount: 7,
      stepKind: 'agent',
      stepSessionAlive: true,
    }).action,
    'skip',
  );
  assert.equal(
    classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 3,
      definitionStepCount: null, // workflow deleted while the run was interrupted
      stepKind: null,
      stepSessionAlive: true,
    }).action,
    'error',
  );
  assert.equal(
    classifyWorkflowRunResume({
      status: 'running',
      currentStepIndex: 9, // the user edited the workflow down to 3 steps
      definitionStepCount: 3,
      stepKind: null,
      stepSessionAlive: true,
    }).action,
    'error',
  );
});

// ---------------------------------------------------------------------------
// Finding the surviving pty
// ---------------------------------------------------------------------------

test('findStepSessionId matches a live pty by its step-dir cwd and ignores junk entries', () => {
  const stepDir = workflowStepDir('C:/resume-project', 'wfrun_x', 3);
  const sessions = [
    null,
    { id: 'tty_other', cwd: 'C:/resume-project' },
    { id: 42, cwd: stepDir }, // non-string id → not usable
    { cwd: stepDir }, // no id
    { id: 'tty_step3', cwd: stepDir },
  ];
  assert.equal(findStepSessionId(sessions as never[], stepDir), 'tty_step3');
  assert.equal(
    findStepSessionId(sessions as never[], workflowStepDir('C:/resume-project', 'wfrun_x', 4)),
    null,
    'a different step index must not match',
  );
  assert.equal(findStepSessionId([], stepDir), null);
});

test('findStepSessionId tolerates separator/case drift in the reported cwd', () => {
  const stepDir = workflowStepDir('C:/resume-project', 'wfrun_x', 2);
  const drifted =
    process.platform === 'win32'
      ? stepDir.replace(/\\/g, '/').toLowerCase()
      : stepDir.replace(/\/+/g, '//');
  assert.equal(findStepSessionId([{ id: 'tty_a', cwd: drifted }], stepDir), 'tty_a');
});
