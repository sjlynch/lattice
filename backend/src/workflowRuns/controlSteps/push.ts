// 'push' control step — drain Ready-to-Merge, then push.
//
// Waits for Ready-to-Merge to drain, then spawns a push session (same code
// path as the Task Board cloud icon, but with the push-only WORKFLOW brief: it
// pushes what is already committed and never stages or commits — see
// instructionTemplates/templates/workflowPush.ts) and waits for its Stop hook,
// with a hard timeout backstop and prompt cancellation handling so the project
// run-lock is never held longer than necessary.

import {
  attachedPushSession,
  cleanupPushSession,
  findCompletedPushRunForWorkflowStep,
  findRunningPushRunForWorkflowStep,
  forgetPushRun,
  getPushRun,
  markPushRunDone,
  startPushSession,
  subscribePushRuns,
  type StartedPushSession,
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
// workflow forever. 15 minutes is generous for a normal git push. A backend
// restart during the wait re-dispatches the step, which re-attaches to the
// still-live session and starts a fresh timeout.
const PUSH_STEP_TIMEOUT_MS = 15 * 60 * 1000;

// Backstop for the Ready-to-Merge drain. Push runs after the Merge step, so the
// lane is usually already empty — but a task stuck ready_to_merge (its merge
// never lands, agent died, …) would otherwise hang this step forever holding the
// cross-process project run-lock. This is a NO-PROGRESS bound (see
// waitForLaneEmpty): it only trips after the lane goes this long WITHOUT a task
// leaving it, so a slowly-draining lane is never killed mid-drain.
const PUSH_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

// Injectable seam (production default below). Tests exercise cancellation and
// timeout while startup waits for capacity or drains an in-flight PTY create,
// plus the post-spawn guard and adoption of a recovered session.
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
  // Drop the finished push run from the in-memory registry. The Task Board's
  // push is forgotten by its UI poller (DELETE /api/push-runs/:id); nothing
  // polls a workflow step's push, so without this every workflow push stayed
  // in the map for the life of the process. The registry never forgets a run
  // that is still `running`. Optional so test doubles can omit it.
  forgetPushRun?: (id: string) => void;
  // Override for PUSH_STEP_TIMEOUT_MS so the timeout path is testable.
  pushTimeoutMs?: number;
  // The still-live push session this step already spawned, if any (see the
  // re-dispatch note in runPushStep). Optional so test doubles can omit it.
  findLivePushSession?: (runId: string, stepIndex: number) => StartedPushSession | undefined;
  // A push session this step spawned that already FINISHED successfully (its
  // `/done` landed — e.g. replayed after a restart before this re-dispatch).
  // Optional so test doubles can omit it.
  findCompletedPushRun?: (runId: string, stepIndex: number) => { id: string } | undefined;
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

function findLivePushSession(runId: string, stepIndex: number): StartedPushSession | undefined {
  const run = findRunningPushRunForWorkflowStep(runId, stepIndex);
  return run ? attachedPushSession(run) : undefined;
}

const productionDeps: PushStepDeps = {
  startPushSession,
  getPushRun,
  subscribePushRuns,
  proxyKillSession,
  subscribeWorkflowRuns: subscribe,
  waitForLaneEmpty,
  abandonPushRun,
  forgetPushRun,
  findLivePushSession,
  findCompletedPushRun: findCompletedPushRunForWorkflowStep,
};

// Re-dispatch after a backend restart (recovery/workflowRunResume.ts): the
// Push step died with the old process, but the push session it spawned lives
// in the detached terminal-server and may still be pushing. Boot recovery
// re-adopted its persisted record, so wait for THAT session instead of
// spawning a second push alongside it. (Its drain already happened.)
// Its push may even have FINISHED already: the agent's `/done` can land (the
// hook still retrying, or the callback outbox replaying it) after listen but
// before this re-dispatch. Then the step is done — never push a second time.
// Otherwise (nothing to adopt) wait for Ready-to-Merge to drain.
async function adoptOrDrain(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  deps: PushStepDeps,
): Promise<{ completed: true } | { adopted?: StartedPushSession }> {
  const completed = deps.findCompletedPushRun?.(run.id, stepIndex);
  if (completed) {
    console.log(`[workflow-run] ${run.id} push step: its push session ${completed.id} already finished before the restart — push complete`);
    deps.forgetPushRun?.(completed.id);
    emitControlProgress(run, stepIndex, 'push', 1, 1, 'push complete');
    return { completed: true };
  }
  const adopted = deps.findLivePushSession?.(run.id, stepIndex);
  if (adopted) {
    console.log(`[workflow-run] ${run.id} push step re-attached to live push session ${adopted.id}`);
    return { adopted };
  }
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
  return {};
}

type PushSessionWatch = {
  // Resolves once the push run reports `done`, the workflow run is
  // cancelled/errored, the timeout fires, or killAndAbandon() runs.
  readonly done: Promise<void>;
  // Owned by this attempt; reaches the spawn queue through the scratch adapters.
  readonly signal: AbortSignal;
  readonly sessionId: string | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly timeoutMessage: string;
  // Record the spawned (or adopted) session so the subscribers can match it.
  attach(session: StartedPushSession): void;
  // Kill the session's pty (if it has spawned), settle the push run and
  // release `done`. With `awaitKill` the settle waits for the kill; otherwise
  // the kill is fire-and-forget and the settle runs synchronously.
  killAndAbandon(awaitKill?: boolean): Promise<void>;
  resolveDone(): void;
  dispose(): void;
};

// Subscribe before spawning so we don't miss a fast 'done' event. The
// session id isn't known until startPushSession returns, so the listener
// captures it via closure once we have it (attach()).
function createPushSessionWatch(
  wf: Workflow,
  run: WorkflowRun,
  deps: PushStepDeps,
): PushSessionWatch {
  const controller = new AbortController();
  let sessionId: string | null = null;
  let sessionServerId: string | undefined;
  // Set by the cancel handler. startPushSession's serverId isn't known until it
  // resolves, so a cancel that fires MID-spawn can't kill the pty yet — this
  // flag lets the post-spawn re-check in runPushStep kill it the moment it
  // exists (Fix 3).
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
  const killAndAbandon = async (awaitKill = false): Promise<void> => {
    if (sessionServerId) {
      const killing = deps.proxyKillSession(sessionServerId).catch(() => undefined);
      if (awaitKill) await killing;
    }
    abandonSession();
    resolveDone();
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
    // Remove an unstarted admission. If PTY creation is already in flight,
    // queuedCreateSession drains and reclaims it before startup rejects.
    controller.abort(new Error('push step cancelled'));
    // Kill an attached session too. The post-spawn re-check covers cancellation
    // after the queue delivered its result but before watch.attach().
    void killAndAbandon();
  });
  // Hard timeout backstop. If Claude crashed before the Stop hook fired the
  // workflow would otherwise wait forever. A timeout is a FAILURE, not a
  // completion: nothing confirmed the push landed, so the step throws in
  // runPushStep and controlStep.ts errors the run (it used to report
  // 'push complete' and advance). A push whose own /done already landed is not
  // a timeout.
  const timeoutMs = deps.pushTimeoutMs ?? PUSH_STEP_TIMEOUT_MS;
  const timeoutMessage = `push step timed out after ${describeTimeout(timeoutMs)}`;
  let timedOut = false;
  const timeout = setTimeout(() => {
    if (sessionId && deps.getPushRun(sessionId)?.status === 'done') {
      resolveDone();
      return;
    }
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
    console.warn(`[workflow-run] ${run.id} ${timeoutMessage} — killing the push session`);
    void killAndAbandon();
  }, timeoutMs);

  return {
    done,
    signal: controller.signal,
    get sessionId() { return sessionId; },
    get cancelled() { return cancelled; },
    get timedOut() { return timedOut; },
    timeoutMessage,
    attach(session) {
      sessionId = session.id;
      sessionServerId = session.serverId;
    },
    killAndAbandon,
    resolveDone: () => resolveDone(),
    dispose() {
      clearTimeout(timeout);
      unsubPush();
      unsubWf();
    },
  };
}

export async function runPushStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
  deps: PushStepDeps = productionDeps,
): Promise<void> {
  const prior = await adoptOrDrain(wf, run, stepIndex, deps);
  if ('completed' in prior) return;
  const { adopted } = prior;
  if (run.status !== 'running') return;

  emitControlProgress(run, stepIndex, 'push', 0, 1, 'pushing to remote');

  const watch = createPushSessionWatch(wf, run, deps);

  try {
    // The owning step is recorded on the push run (and persisted) so a
    // re-dispatch after a restart can find it — see `adopted` above.
    const session = adopted ?? await deps.startPushSession(wf.projectPath, backendOrigin, {
      brief: 'workflow',
      workflow: { runId: run.id, stepIndex },
      signal: watch.signal,
    });
    watch.attach(session);

    // Cancel/timeout race guard (Fix 3): if the run was cancelled (or otherwise
    // left 'running') WHILE startPushSession was in flight, the cancel handler
    // ran with sessionServerId still undefined and killed nothing. Now that the
    // pty exists, kill it and bail — a cancelled push must NOT stay live and run
    // `git push` to completion. Mirrors the post-spawn 'already done' guard below.
    // A timeout that fired mid-spawn is handled the same way, then fails below.
    if (watch.cancelled || watch.timedOut || run.status !== 'running') {
      await watch.killAndAbandon(true);
      if (watch.timedOut && !watch.cancelled && run.status === 'running') {
        throw new Error(watch.timeoutMessage);
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
    if (current && current.status === 'done') watch.resolveDone();

    await watch.done;
    // A cancel wins over a timeout: the run keeps its cancelled state.
    if (watch.cancelled || run.status !== 'running') return;
    if (watch.timedOut) throw new Error(watch.timeoutMessage);
    // Settled by boot recovery's liveness watch: the (re-adopted) session's
    // terminal died without calling `/done`, so nothing confirmed the push.
    if (deps.getPushRun(session.id)?.lost) {
      throw new Error('push session terminal exited without reporting completion');
    }
    emitControlProgress(run, stepIndex, 'push', 1, 1, 'push complete');
  } catch (err) {
    // Await startup itself: aborting it withdraws queued work and drains any
    // PTY already being created before the control-step lock can be released.
    // Only our abort is a normal cancellation; preserve real cleanup failures.
    if (watch.signal.aborted && err === watch.signal.reason &&
        (watch.cancelled || run.status !== 'running')) return;
    // The timeout abort reason carries the push timeout message to the worker,
    // which errors the still-running workflow instead of advancing it.
    throw err;
  } finally {
    watch.dispose();
    if (watch.sessionId) deps.forgetPushRun?.(watch.sessionId);
  }
}
