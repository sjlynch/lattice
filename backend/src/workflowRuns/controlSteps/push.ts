// 'push' control step — drain Ready-to-Merge, then push.
//
// Waits for Ready-to-Merge to drain, then spawns a push session (same code
// path as the Task Board cloud icon) and waits for its Stop hook, with a hard
// timeout backstop and prompt cancellation handling so the project run-lock is
// never held longer than necessary.

import {
  cleanupPushSession,
  getPushRun,
  markPushRunDone,
  startPushSession,
  subscribePushRuns,
} from '../../pushRuns.js';
import { pushAgentId } from '../../pushRuns/stopHook.js';
import { unregisterAgentSession } from '../../agentSessions.js';
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

// Backstop for the Ready-to-Merge drain. Push runs after the Merge step, so the
// lane is usually already empty — but a task stuck ready_to_merge (its merge
// never lands, agent died, …) would otherwise hang this step forever holding the
// cross-process project run-lock. This is a NO-PROGRESS bound (see
// waitForLaneEmpty): it only trips after the lane goes this long WITHOUT a task
// leaving it, so a slowly-draining lane is never killed mid-drain.
const PUSH_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

// Injectable seam (production default below). The cancel/timeout race around
// startPushSession (Fix 3) is the subtle part, so the regression test overrides
// these to fire a 'cancelled' event WHILE startPushSession is in flight and
// asserts the resolved session is killed and no 'push complete' is emitted.
export type PushStepDeps = {
  startPushSession: typeof startPushSession;
  getPushRun: typeof getPushRun;
  subscribePushRuns: typeof subscribePushRuns;
  proxyKillSession: typeof proxyKillSession;
  subscribeWorkflowRuns: typeof subscribe;
  waitForLaneEmpty: typeof waitForLaneEmpty;
  // Settle a push session the step gave up on (cancel / timeout) the way its
  // own /done callback would. Optional so test doubles can omit it.
  abandonPushRun?: (projectPath: string, id: string) => void;
  // Override for PUSH_STEP_TIMEOUT_MS so the timeout path is testable.
  pushTimeoutMs?: number;
};

function describeTimeout(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const min = ms / 60_000;
    return `${min} minute${min === 1 ? '' : 's'}`;
  }
  return `${ms}ms`;
}

// A session the step killed never reaches its Stop hook, so nothing else marked
// the push run done (it stayed `running` in the registry for the life of the
// process), dropped its orange graph node (left until the 30-min silence
// sweep), or removed its scratch dir (left until the next boot sweep).
function abandonPushRun(projectPath: string, id: string): void {
  unregisterAgentSession(pushAgentId(id));
  markPushRunDone(id);
  void cleanupPushSession(projectPath, id);
}

const productionDeps: PushStepDeps = {
  startPushSession,
  getPushRun,
  subscribePushRuns,
  proxyKillSession,
  subscribeWorkflowRuns: subscribe,
  waitForLaneEmpty,
  abandonPushRun,
};

export async function runPushStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: PushStepDeps = productionDeps,
): Promise<void> {
  emitControlProgress(
    run,
    stepIndex,
    'push',
    0,
    1,
    'waiting for Ready to Merge to drain',
  );
  await deps.waitForLaneEmpty(
    wf.projectPath,
    run,
    'ready_to_merge',
    (count, total) => {
      emitControlProgress(
        run,
        stepIndex,
        'push',
        0,
        1,
        `Ready to Merge draining: ${count}/${total} remaining`,
      );
    },
    PUSH_DRAIN_TIMEOUT_MS,
  );
  if (run.status !== 'running') return;

  emitControlProgress(run, stepIndex, 'push', 0, 1, 'pushing to remote');

  // Subscribe before spawning so we don't miss a fast 'done' event. The
  // session id isn't known until startPushSession returns, so the listener
  // captures it via closure once we have it.
  let sessionId: string | null = null;
  let sessionServerId: string | undefined;
  // Set by the cancel handler. startPushSession's serverId isn't known until it
  // resolves, so a cancel that fires MID-spawn can't kill the pty yet — this
  // flag lets the post-spawn re-check below kill it the moment it exists (Fix 3).
  let cancelled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  // Once the step has killed its session, settle the push run too (see
  // abandonPushRun). A push whose own /done already landed is left alone.
  let abandoned = false;
  const abandonSession = (): void => {
    if (abandoned || !sessionId) return;
    if (deps.getPushRun(sessionId)?.status === 'done') return;
    abandoned = true;
    deps.abandonPushRun?.(wf.projectPath, sessionId);
  };
  const unsubPush = deps.subscribePushRuns((ev) => {
    if (ev.type !== 'done') return;
    if (sessionId && ev.run.id === sessionId) resolveDone();
  });
  // Also resolve early if the workflow run is cancelled/errored. Without
  // this the await on `done` would hang until Claude's Stop hook fires (or
  // forever if the pty was already killed by something else), keeping the
  // project run-lock held the whole time.
  const unsubWf = deps.subscribeWorkflowRuns((ev) => {
    if (ev.type !== 'cancelled' && ev.type !== 'errored') return;
    if (!('run' in ev) || ev.run.id !== run.id) return;
    cancelled = true;
    // If the session already spawned, kill it now. If startPushSession is still
    // in flight (serverId not yet known), the post-spawn re-check below kills it
    // once it resolves — otherwise the push would run to completion despite the
    // cancel and only be reaped by its own Stop hook/timeout.
    if (sessionServerId) {
      deps.proxyKillSession(sessionServerId).catch(() => undefined);
    }
    abandonSession();
    resolveDone();
  });
  // Hard timeout backstop. If Claude crashed before the Stop hook fired the
  // workflow would otherwise wait forever. A timeout is a FAILURE, not a
  // completion: nothing confirmed the push landed, so the step throws below and
  // controlStep.ts errors the run (it used to report 'push complete' and
  // advance). A push whose own /done already landed is not a timeout.
  const timeoutMs = deps.pushTimeoutMs ?? PUSH_STEP_TIMEOUT_MS;
  const timeoutMessage = `push step timed out after ${describeTimeout(timeoutMs)}`;
  let timedOut = false;
  const timeout = setTimeout(() => {
    if (sessionId && deps.getPushRun(sessionId)?.status === 'done') {
      resolveDone();
      return;
    }
    timedOut = true;
    console.warn(`[workflow-run] ${run.id} ${timeoutMessage} — killing the push session`);
    if (sessionServerId) {
      deps.proxyKillSession(sessionServerId).catch(() => undefined);
    }
    abandonSession();
    resolveDone();
  }, timeoutMs);

  try {
    const session = await deps.startPushSession(wf.projectPath, backendOrigin);
    sessionId = session.id;
    sessionServerId = session.serverId;

    // Cancel/timeout race guard (Fix 3): if the run was cancelled (or otherwise
    // left 'running') WHILE startPushSession was in flight, the cancel handler
    // ran with sessionServerId still undefined and killed nothing. Now that the
    // pty exists, kill it and bail — a cancelled push must NOT stay live and run
    // `git push` to completion. Mirrors the post-spawn 'already done' guard below.
    // A timeout that fired mid-spawn is handled the same way, then fails below.
    if (cancelled || timedOut || run.status !== 'running') {
      if (session.serverId) {
        await deps.proxyKillSession(session.serverId).catch(() => undefined);
      }
      abandonSession();
      resolveDone();
      if (timedOut && !cancelled && run.status === 'running') {
        throw new Error(timeoutMessage);
      }
      return;
    }

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
    const current = deps.getPushRun(session.id);
    if (current && current.status === 'done') resolveDone();

    await done;
    // A cancel wins over a timeout: the run keeps its cancelled state.
    if (cancelled || run.status !== 'running') return;
    if (timedOut) throw new Error(timeoutMessage);
    emitControlProgress(run, stepIndex, 'push', 1, 1, 'push complete');
  } finally {
    clearTimeout(timeout);
    unsubPush();
    unsubWf();
  }
}
