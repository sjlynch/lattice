import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelWorkflowStepSessions,
  enqueueWorkflowStepSession,
} from '../workflowRuns/sessionSpawner.js';
import { subscribe, type WorkflowRunEvent, type WorkflowRun } from '../workflowRuns/state.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';

function makeRun(): WorkflowRun {
  return {
    id: `wfrun_spawn_fail_${Date.now()}`,
    workflowId: 'wf',
    workflowName: 'workflow',
    projectPath: '/project',
    status: 'running',
    startedAt: Date.now(),
    totalSteps: 1,
    currentStepIndex: 0,
  };
}

test('workflow step spawn failure errors the run instead of emitting a serverId-less terminal', async () => {
  // The spawn queue only admits after a healthy terminal count poll. Prime the
  // in-memory accounting directly so this unit test can exercise the admitted
  // thunk without booting terminal-server.
  queueState.accounting.reconcile(0, Date.now());

  const run = makeRun();
  const events: WorkflowRunEvent[] = [];
  const unsubscribe = subscribe((ev) => {
    if ('run' in ev && ev.run.id === run.id) events.push(ev);
    if (ev.type === 'step-spawned' && ev.runId === run.id) events.push(ev);
  });

  try {
    await assert.rejects(
      enqueueWorkflowStepSession({
        run,
        stepIndex: 0,
        projectPath: run.projectPath,
        stepDir: '/tmp/workflow-step',
        command: 'claude --dangerously-skip-permissions',
        harness: 'claude',
        deps: {
          proxyCreateSession: async () => ({ error: 'terminal-server down' }),
        },
      }),
      /terminal-server down/,
    );
  } finally {
    unsubscribe();
  }

  assert.equal(run.status, 'errored');
  assert.match(run.error ?? '', /terminal-server down/);
  assert.equal(
    events.some((ev) => ev.type === 'errored' && ev.run.status === 'errored'),
    true,
    'frontend subscribers receive the errored run state',
  );
  assert.equal(
    events.some((ev) => ev.type === 'step-spawned'),
    false,
    'no serverId-less step-spawned event is emitted for a failed session',
  );
});

test('cancelling a queued workflow step prevents later step-spawned delivery', async () => {
  queueState.accounting.setSoftCap(1);
  queueState.accounting.reconcile(1, Date.now());

  const run = makeRun();
  const events: WorkflowRunEvent[] = [];
  let createCalled = false;
  const unsubscribe = subscribe((ev) => {
    if (ev.type === 'step-spawned' && ev.runId === run.id) events.push(ev);
  });

  const done = enqueueWorkflowStepSession({
    run,
    stepIndex: 0,
    projectPath: run.projectPath,
    stepDir: '/tmp/workflow-step-queued',
    command: 'claude --dangerously-skip-permissions',
    harness: 'claude',
    deps: {
      proxyCreateSession: async () => {
        createCalled = true;
        return { id: 'should-not-spawn' };
      },
    },
  });

  try {
    run.status = 'cancelled';
    cancelWorkflowStepSessions(run.id, {
      proxyKillSession: async () => true,
    });
    await assert.rejects(done, /spawn cancelled/);
  } finally {
    unsubscribe();
    queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
    queueState.accounting.reconcile(0, Date.now() + 1);
  }

  assert.equal(createCalled, false, 'pending spawn thunk is removed before admission');
  assert.equal(
    events.some((ev) => ev.type === 'step-spawned'),
    false,
    'cancelled queued step never emits step-spawned',
  );
});

test('cancelling a spawned workflow step kills its terminal session', async () => {
  queueState.accounting.setSoftCap(1);
  queueState.accounting.reconcile(0, Date.now());

  const run = makeRun();
  const killedIds: string[] = [];
  let resolveKilled!: () => void;
  const killed = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });

  try {
    await enqueueWorkflowStepSession({
      run,
      stepIndex: 0,
      projectPath: run.projectPath,
      stepDir: '/tmp/workflow-step-spawned',
      command: 'claude --dangerously-skip-permissions',
      harness: 'claude',
      deps: {
        proxyCreateSession: async () => ({ id: 'wf-step-session-1' }),
      },
    });

    run.status = 'cancelled';
    cancelWorkflowStepSessions(run.id, {
      proxyKillSession: async (id: string) => {
        killedIds.push(id);
        resolveKilled();
        return true;
      },
    });
    await killed;
  } finally {
    queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
    queueState.accounting.reconcile(0, Date.now() + 1);
  }

  assert.deepEqual(killedIds, ['wf-step-session-1']);
});
