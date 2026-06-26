import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueWorkflowStepSession } from '../workflowRuns/sessionSpawner.js';
import { subscribe, type WorkflowRunEvent, type WorkflowRun } from '../workflowRuns/state.js';
import { queueState } from '../spawnQueue/state.js';

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
