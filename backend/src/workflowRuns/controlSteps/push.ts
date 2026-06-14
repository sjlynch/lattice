// 'push' control step — drain Ready-to-Merge, then push.
//
// Waits for Ready-to-Merge to drain, then spawns a push session (same code
// path as the Task Board cloud icon) and waits for its Stop hook, with a hard
// timeout backstop and prompt cancellation handling so the project run-lock is
// never held longer than necessary.

import {
  getPushRun,
  startPushSession,
  subscribePushRuns,
} from '../../pushRuns.js';
import { proxyKillSession } from '../../terminalProxy.js';
import type { Workflow } from '../../workflows.js';
import { notify, subscribe, type WorkflowRun } from '../state.js';
import { emitControlProgress, waitForLaneEmpty } from './shared.js';

// Upper bound on how long the push step will wait for Claude's Stop hook. The
// session is "trust Claude to stop" (mirrors the Task Board cloud icon), but
// if Claude crashed before its Stop hook fired we'd otherwise hang the whole
// workflow forever. 15 minutes is generous for a normal git push, and dev
// restarts during the wait clear it anyway.
const PUSH_STEP_TIMEOUT_MS = 15 * 60 * 1000;

export async function runPushStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  emitControlProgress(
    run,
    stepIndex,
    'push',
    0,
    1,
    'waiting for Ready to Merge to drain',
  );
  await waitForLaneEmpty(wf.projectPath, run, 'ready_to_merge', (count, total) => {
    emitControlProgress(
      run,
      stepIndex,
      'push',
      0,
      1,
      `Ready to Merge draining: ${count}/${total} remaining`,
    );
  });
  if (run.status !== 'running') return;

  emitControlProgress(run, stepIndex, 'push', 0, 1, 'pushing to remote');

  // Subscribe before spawning so we don't miss a fast 'done' event. The
  // session id isn't known until startPushSession returns, so the listener
  // captures it via closure once we have it.
  let sessionId: string | null = null;
  let sessionServerId: string | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const unsubPush = subscribePushRuns((ev) => {
    if (ev.type !== 'done') return;
    if (sessionId && ev.run.id === sessionId) resolveDone();
  });
  // Also resolve early if the workflow run is cancelled/errored. Without
  // this the await on `done` would hang until Claude's Stop hook fires (or
  // forever if the pty was already killed by something else), keeping the
  // project run-lock held the whole time.
  const unsubWf = subscribe((ev) => {
    if (ev.type !== 'cancelled' && ev.type !== 'errored') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    if (sessionServerId) {
      proxyKillSession(sessionServerId).catch(() => undefined);
    }
    resolveDone();
  });
  // Hard timeout backstop. If Claude crashed before the Stop hook fired the
  // workflow would otherwise wait forever. Log loud so the user can diagnose.
  const timeout = setTimeout(() => {
    console.warn(
      `[workflow-run] ${run.id} push step timed out after ${PUSH_STEP_TIMEOUT_MS}ms — resolving`,
    );
    if (sessionServerId) {
      proxyKillSession(sessionServerId).catch(() => undefined);
    }
    resolveDone();
  }, PUSH_STEP_TIMEOUT_MS);

  try {
    const session = await startPushSession(wf.projectPath, backendOrigin);
    sessionId = session.id;
    sessionServerId = session.serverId;

    // Surface the push terminal exactly like the Task Board cloud icon does:
    // emit a step-spawned event so useWorkflowRuns lazy-mounts a terminal tab.
    notify({
      type: 'step-spawned',
      runId: run.id,
      projectPath: wf.projectPath,
      stepIndex,
      command: session.command,
      cwd: session.cwd,
      serverId: session.serverId,
    });

    // Race condition guard: the Stop hook could conceivably fire between
    // startPushSession recording the run and our subscriber being attached
    // (subscriber is attached first; this is belt-and-suspenders).
    const current = getPushRun(session.id);
    if (current && current.status === 'done') resolveDone();

    await done;
    if (run.status !== 'running') return;
    emitControlProgress(run, stepIndex, 'push', 1, 1, 'push complete');
  } finally {
    clearTimeout(timeout);
    unsubPush();
    unsubWf();
  }
}
