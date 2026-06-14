import { queuedCreateSession } from '../queuedCreateSession.js';
import { normalizeAgentHarness } from '../harnesses.js';
import { getUserSettings } from '../userSettings.js';
import { buildPostMergeHookCommand } from './commands.js';
import {
  finishPostMergeHook,
  getActiveHookForProject,
  patchPostMergeHook,
  recordPostMergeHook,
} from './registry.js';
import { postMergeHookAgentId } from './stopHook.js';
import { registerAgentSession } from '../agentSessions.js';
import { setupPostMergeHookSession } from './sessionSetup.js';
import type { PostMergeHookRun } from './types.js';

export type TriggerPostMergeHookOptions = {
  projectPath: string;
  backendOrigin: string;
  trigger: 'merge-run' | 'manual-merge';
};

export type TriggerPostMergeHookOutcome =
  | { kind: 'skipped'; reason: 'no-prompt' }
  | { kind: 'skipped'; reason: 'already-running'; existing: PostMergeHookRun }
  | { kind: 'started'; run: PostMergeHookRun; serverId?: string }
  | { kind: 'error'; message: string };

// Triggers a post-merge hook and returns immediately with an outcome
// describing whether one started. Callers that need to block until the hook
// finishes should additionally `await waitForPostMergeHook(run.id)` (see
// `runPostMergeHookGate` in session.ts).
//
// Empty prompt → skipped (no-op so callers can fire-and-await unconditionally).
// Hook already running for this project → skipped; caller should await the
// existing one (which they typically already do via the same waiter promise).
//
// The filesystem/trust/installation work is delegated to
// `setupPostMergeHookSession` (sessionSetup.ts); this module owns the
// decision-and-outcome side: the no-prompt / already-running gates, recording
// the run, spawning the pty, and the orange agent-session node lifecycle.
export async function triggerPostMergeHook(
  options: TriggerPostMergeHookOptions,
): Promise<TriggerPostMergeHookOutcome> {
  const { projectPath, backendOrigin, trigger } = options;
  const settings = await getUserSettings(projectPath);
  const prompt = (settings.postMergeHookPrompt ?? '').trim();
  if (!prompt) return { kind: 'skipped', reason: 'no-prompt' };

  const existing = getActiveHookForProject(projectPath);
  if (existing) {
    return { kind: 'skipped', reason: 'already-running', existing };
  }

  const harness = normalizeAgentHarness(settings.postMergeHookHarness);

  try {
    const session = await setupPostMergeHookSession({
      projectPath,
      backendOrigin,
      prompt,
      harness,
    });

    // Record the run BEFORE creating the pty so the waiter map is in place
    // if the harness curls /complete unusually fast (e.g. on a network-cached
    // command). The pty cwd is the *scratch dir* — same pattern as pushRuns.
    // Claude reads `.claude/settings.local.json` (Stop hook) from cwd, and
    // Pi loads `.pi/extensions/` from cwd; running with cwd=projectPath would
    // miss both backstops and the merge run would hang waiting for a Stop
    // hook callback that never fires (this exact bug shipped in the first
    // cut). The agent cds into the project as its first step — see
    // renderPostMergeHookInstructions.
    const run: PostMergeHookRun = {
      id: session.id,
      projectPath,
      harness,
      prompt,
      cwd: session.cwd,
      status: 'running',
      startedAt: Date.now(),
      trigger,
    };
    recordPostMergeHook(run);

    const command = buildPostMergeHookCommand({
      harness,
      instructionsFile: session.instructionsFile,
    });

    console.log(
      `[post-merge-hook] spawning ${harness} for run ${session.id} ` +
        `(trigger=${trigger}, cwd=${session.cwd}, prompt=${prompt.length}ch)`,
    );

    // `priority` band — the post-merge hook gates merge-run / manual-merge
    // completion, so it must not be starved behind batch task spawns.
    const sess = await queuedCreateSession({
      kind: 'post-merge-hook',
      priority: 'priority',
      dedupeKey: `post-merge-hook:${projectPath}`,
      opts: { cwd: session.cwd, initialCommand: command, projectPath },
    });

    if ('error' in sess) {
      // Spawn failed — mark the hook errored so anyone awaiting it unblocks.
      console.error(
        `[post-merge-hook] spawn failed for run ${session.id}: ${sess.error}`,
      );
      finishPostMergeHook(session.id, 'errored', sess.error);
      return { kind: 'error', message: sess.error };
    }

    const updated = patchPostMergeHook(session.id, { serverId: sess.id });
    // Presence: orange Claude node for this non-worktree session. Only for
    // Claude — a Pi/codex hook isn't a "Claude session" and has no activity
    // hooks, so it gets no node.
    if (harness === 'claude') {
      registerAgentSession({
        agentId: postMergeHookAgentId(session.id),
        projectPath,
        label: 'post-merge hook',
      });
    }
    return { kind: 'started', run: updated ?? run, serverId: sess.id };
  } catch (err) {
    const message = (err as Error).message;
    console.error('[post-merge-hook] trigger failed:', err);
    return { kind: 'error', message };
  }
}
