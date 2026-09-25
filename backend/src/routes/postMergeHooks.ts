// Post-merge hook lifecycle routes. The hook itself is fired by the merge
// finalizers (mergeRuns.ts / worktree/finalize.ts); these endpoints expose:
//
//   GET    /api/post-merge-hooks/active?project=
//          The active or most-recent hook for a project (UI rehydration).
//   POST   /api/post-merge-hooks/:id/complete
//          Stop-hook callback. Idempotent. Optional ?error= surfaces a failure
//          state to the UI without leaving the merge run blocked.
//   POST   /api/post-merge-hooks/:id/abort
//          User clicked "Abort" in the UI. Same effect as /complete with an
//          error, plus tries to tear down the pty by serverId.

import { Router } from 'express';
import {
  endPostMergeHook,
  finishPostMergeHook,
  getActiveHookForProject,
  getMostRecentHookForProject,
  getPostMergeHook,
  postMergeHookStore,
} from '../postMergeHooks.js';
import { patchPostMergeHook } from '../postMergeHooks/registry.js';
import { canonicalProjectPath } from '../projectPath.js';
import { postMergeHookAgentId } from '../postMergeHooks/stopHook.js';
import {
  cancelPostMergeHookStopGate,
  postMergeHookStopFinish,
  requestPostMergeHookStopComplete,
} from '../postMergeHooks/stopHookGate.js';
import { unregisterAgentSession } from '../agentSessions.js';
import { forgetAgentQuiescence } from '../agentQuiescence.js';
import { cleanupPostMergeHookSession } from '../postMergeHooks/cleanup.js';
import { finishHomeScratchDoneResponse } from '../homeScratch/routes.js';
import { readProjectParam } from './projectParam.js';

export function buildPostMergeHooksRouter(): Router {
  const r = Router();

  r.get('/api/post-merge-hooks/active', (req, res) => {
    const project = readProjectParam(req, res, { source: 'query' });
    if (project === null) return;
    const key = canonicalProjectPath(project);
    const active = getActiveHookForProject(key);
    if (active) return res.json({ active, recent: null });
    const recent = getMostRecentHookForProject(key);
    res.json({ active: null, recent });
  });

  r.post('/api/post-merge-hooks/:id/complete', async (req, res) => {
    const id = req.params.id;
    const agentId = postMergeHookAgentId(id);
    const source =
      typeof req.query.source === 'string' ? req.query.source : 'unknown';
    const errParam =
      typeof req.query.error === 'string' && req.query.error.trim()
        ? req.query.error.trim().slice(0, 500)
        : undefined;
    const existing = getPostMergeHook(id);
    console.log(
      `[post-merge-hook-complete] id=${id} source=${source}` +
        (errParam ? ` error=${JSON.stringify(errParam)}` : '') +
        (existing ? '' : ' (idempotent: already finished/forgotten)'),
    );

    // The actual finish: drop the graph node + quiescence state, finalize the
    // hook (resolving the merge-run / Phase C waiters), then clean up scratch
    // off the response path — the Stop hook fires while the pty is still
    // winding down, and Windows may need retries after it exits.
    const finish = (tracked: { projectPath: string; id: string }): void => {
      unregisterAgentSession(agentId);
      forgetAgentQuiescence(agentId);
      finishPostMergeHook(id, errParam ? 'errored' : 'completed', errParam);
      void cleanupPostMergeHookSession(tracked.projectPath, tracked.id);
    };

    // Claude's `Stop` hook fires early/repeatedly while a Task subagent is still
    // running, so a Stop-sourced completion must wait for the session to go
    // quiescent before finishing — otherwise the merge run reports `completed`
    // (and a queued workflow's next step dispatches, past Phase C) on top of a
    // still-working post-merge agent. The model's own explicit curl, Pi's
    // `session_shutdown` extension, and Codex's `Stop` hook are deliberate
    // end-of-work signals and finish immediately; an error-tagged completion
    // also finishes immediately (don't gate a reported failure). Mirrors the
    // workflow-step gate (workflowRuns/stopHookGate.ts).
    if (
      existing &&
      existing.status === 'running' &&
      !errParam &&
      source.startsWith('claude-stop-hook')
    ) {
      // Record the Stop durably BEFORE answering (see
      // PostMergeHookRun.stopReceivedAt): the hook won't send it again, and a
      // restart inside the settle window must re-arm the gate, not lose it.
      patchPostMergeHook(id, { stopReceivedAt: Date.now() });
      await postMergeHookStore.flush(existing.projectPath).catch(() => {});
      requestPostMergeHookStopComplete(id, postMergeHookStopFinish(existing.id, existing.projectPath));
      return res.json({ ok: true, gated: true });
    }

    // Immediate finish (model curl / Pi / Codex / error / idempotent no-op).
    // Drop the graph node + any stale gate regardless of tracking state.
    cancelPostMergeHookStopGate(id);
    unregisterAgentSession(agentId);
    await finishHomeScratchDoneResponse({
      res,
      run: existing,
      onRun: (tracked) => finish(tracked),
    });
  });

  // Gate + node + quiescence teardown, best-effort pty kill (immediate user
  // feedback), finish, scratch cleanup — all in `endPostMergeHook`, shared with
  // the terminal-tab close path and the gate's wait expiry. A hook still in its
  // launch window (scratch setup / queued spawn) is caught by the trigger's
  // post-await re-checks, which kill the late pty and skip the node.
  r.post('/api/post-merge-hooks/:id/abort', async (req, res) => {
    await endPostMergeHook(req.params.id, 'aborted', 'aborted by user');
    res.json({ ok: true });
  });

  return r;
}
