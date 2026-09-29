import {
  cleanupPushSession,
  getPushRun,
  markPushRunLost,
  pushRunStore,
  restorePushRun,
  type PushRun,
} from '../../pushRuns.js';
import { pushAgentId } from '../../pushRuns/stopHook.js';
import {
  applyRecordedQaVerdict,
  cleanupQaSession,
  getQaRun,
  markQaRunDone,
  qaAgentId,
  qaRunStore,
  restoreQaRun,
  type QaRun,
} from '../../qaRuns.js';
import {
  endPostMergeHook,
  getPostMergeHook,
  POST_MERGE_HOOK_MAX_WAIT_MS,
  postMergeHookStore,
  restorePostMergeHook,
  waitForPostMergeHook,
  type PostMergeHookRun,
} from '../../postMergeHooks.js';
import { postMergeHookAgentId } from '../../postMergeHooks/stopHook.js';
import { registerAgentSession, unregisterAgentSession } from '../../agentSessions.js';
import { markAgentReadopted } from '../../agentQuiescence.js';
import {
  postMergeHookStopFinish,
  requestPostMergeHookStopComplete,
} from '../../postMergeHooks/stopHookGate.js';
import { READOPTED_HOOK_MIN_WAIT_MS, type Adapter } from './contracts.js';

export const pushAdapter: Adapter<PushRun> = {
  kind: 'push',
  noun: 'push run',
  load: (p) => pushRunStore.load(p),
  // A push whose pty is gone is flagged `lost` up front so a re-dispatched
  // workflow Push step spawns a fresh push instead of attaching to it.
  restore: (run, alive) => restorePushRun(alive ? run : { ...run, lost: true }),
  isRunning: (id) => getPushRun(id)?.status === 'running',
  onReadopted: (run) =>
    registerAgentSession({ agentId: pushAgentId(run.id), projectPath: run.projectPath, label: 'push' }),
  settleLost: async (run) => {
    unregisterAgentSession(pushAgentId(run.id));
    markPushRunLost(run.id);
    await cleanupPushSession(run.projectPath, run.id);
  },
};

export const qaAdapter: Adapter<QaRun> = {
  kind: 'qa',
  noun: 'QA run',
  load: (p) => qaRunStore.load(p),
  restore: (run) => restoreQaRun(run),
  isRunning: (id) => getQaRun(id)?.status === 'running',
  onReadopted: (run) =>
    registerAgentSession({ agentId: qaAgentId(run.id), projectPath: run.projectPath, label: 'qa' }),
  settleLost: async (run) => {
    unregisterAgentSession(qaAgentId(run.id));
    // What `/done` would have done: apply whatever verdict the agent reported
    // before its terminal went away (a confident PASS still promotes the
    // task), then close the run. No verdict ⇒ the task stays in QA. A run
    // already settled is never re-applied (`applyRecordedQaVerdict` refuses a
    // `done` run), so a stale PASS can't promote a since-reworked task.
    try {
      await applyRecordedQaVerdict(run.id);
    } catch (err) {
      console.warn(`[startup] QA run ${run.id}: applying its recorded verdict failed:`, err);
    }
    markQaRunDone(run.id);
    await cleanupQaSession(run.projectPath, run.id);
  },
};

export const postMergeHookAdapter: Adapter<PostMergeHookRun> = {
  kind: 'post-merge-hook',
  noun: 'post-merge hook',
  load: (p) => postMergeHookStore.load(p),
  restore: (run) => restorePostMergeHook(run),
  isRunning: (id) => getPostMergeHook(id)?.status === 'running',
  onReadopted: (run) => {
    const agentId = postMergeHookAgentId(run.id);
    // Graph presence for any harness (each reports activity through its own
    // hooks); the quiescence re-adoption below only matters to Claude, whose
    // Stop hook is the one gated on it.
    registerAgentSession({ agentId, projectPath: run.projectPath, label: 'post-merge hook' });
    if (run.harness === 'claude') {
      // Its live-subagent state died with the old process: a premature Stop
      // must not finish the hook while a pre-restart subagent still works.
      // A Stop the old process was already holding starts the quiet window
      // from that Stop rather than from this boot.
      markAgentReadopted(
        agentId,
        run.stopReceivedAt !== undefined
          ? { stopAt: run.stopReceivedAt, activeAt: run.stopActiveAt, busy: run.stopBusy }
          : undefined,
      );
    }
    // The previous process had received this hook's Stop and was only waiting
    // out the quiescence gate. The hook got its 200 and the agent is idle —
    // no second Stop is coming, so re-arm the gate or the hook just sits
    // "running" until its bounded wait errors it.
    if (run.stopReceivedAt !== undefined) {
      requestPostMergeHookStopComplete(run.id, postMergeHookStopFinish(run.id, run.projectPath), undefined, {
        rearm: true,
      });
    }
    armReadoptedHookWait(run);
  },
  settleLost: async (run, reason) => {
    // Also reclaims the scratch dir (a no-op after the boot sweep took it).
    await endPostMergeHook(run.id, 'errored', `post-merge hook ${reason}`, { killSession: false });
  },
};

// The merge that fired this hook waited on it with a bounded wait
// (`POST_MERGE_HOOK_MAX_WAIT_MS` from its start). That waiter died with the old
// process; re-arm the remainder so a re-adopted hook whose agent hangs is
// still ended rather than blocking the project's next hook (and Phase C)
// forever. A resumed merge run that awaits it adds its own bounded wait too.
function armReadoptedHookWait(run: PostMergeHookRun): void {
  const elapsed = Math.max(0, Date.now() - run.startedAt);
  const remaining = Math.max(READOPTED_HOOK_MIN_WAIT_MS, POST_MERGE_HOOK_MAX_WAIT_MS - elapsed);
  void waitForPostMergeHook(run.id, remaining)
    .then(async (result) => {
      if (result === 'expired') {
        await endPostMergeHook(run.id, 'errored', 'timed out', { killSession: true });
      }
    })
    .catch((err) => console.warn(`[post-merge-hook] ${run.id}: re-adopted wait failed:`, err));
}
