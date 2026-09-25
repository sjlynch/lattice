import {
  queuedCreateSession,
  type QueuedCreateSessionArgs,
} from '../queuedCreateSession.js';
import { normalizeAgentHarness } from '../harnesses.js';
import type { AgentHarness } from '../harnesses.js';
import { normalizePiModel } from '../piModels.js';
import { getUserSettings } from '../userSettings.js';
import type { UserSettings } from '../userSettings/types.js';
import type { CreateSessionResult } from '../terminalServerClient.js';
import { buildPostMergeHookCommand } from './commands.js';
import {
  beginPostMergeHookTrigger,
  finishPostMergeHook,
  getActiveHookForProject,
  getPostMergeHook,
  patchPostMergeHook,
  recordPostMergeHook,
} from './registry.js';
import { postMergeHookAgentId } from './stopHook.js';
import { registerAgentSession } from '../agentSessions.js';
import { proxyKillSession } from '../terminalProxy.js';
import { setupPostMergeHookSession } from './sessionSetup.js';
import { cleanupPostMergeHookSession } from './cleanup.js';
import { clearPostMergeHookOwed, readPostMergeHookOwedSince } from './owed.js';
import {
  assertSafePostMergeHookPath,
  createPostMergeHookId,
} from './paths.js';
import type { PostMergeHookRun, PostMergeHookSession } from './types.js';

export type TriggerPostMergeHookOptions = {
  projectPath: string;
  backendOrigin: string;
  trigger: 'merge-run' | 'manual-merge';
};

export type TriggerPostMergeHookOutcome =
  | { kind: 'skipped'; reason: 'no-prompt' }
  | { kind: 'skipped'; reason: 'disabled' }
  | { kind: 'skipped'; reason: 'already-running'; existing: PostMergeHookRun }
  // The user aborted the hook while its scratch setup / queued pty spawn was
  // still in flight: the run is already terminal, no session was kept.
  | { kind: 'skipped'; reason: 'aborted'; run: PostMergeHookRun }
  | { kind: 'started'; run: PostMergeHookRun; serverId?: string }
  | { kind: 'error'; message: string };

export type TriggerPostMergeHookDeps = {
  getUserSettings: (projectPath: string) => Promise<UserSettings>;
  getActiveHookForProject: (projectPath: string) => PostMergeHookRun | null;
  getPostMergeHook: (id: string) => PostMergeHookRun | null;
  setupPostMergeHookSession: (args: {
    projectPath: string;
    backendOrigin: string;
    prompt: string;
    harness: PostMergeHookSession['harness'];
    id: string;
  }) => Promise<PostMergeHookSession>;
  recordPostMergeHook: (run: PostMergeHookRun) => void;
  queuedCreateSession: (
    args: QueuedCreateSessionArgs,
  ) => Promise<CreateSessionResult>;
  finishPostMergeHook: (
    id: string,
    status: 'completed' | 'aborted' | 'errored',
    error?: string,
  ) => PostMergeHookRun | null;
  patchPostMergeHook: (
    id: string,
    patch: Partial<PostMergeHookRun>,
  ) => PostMergeHookRun | null;
  registerAgentSession: typeof registerAgentSession;
  cleanupPostMergeHookSession: (projectPath: string, id: string) => Promise<void>;
  killSession: (serverId: string) => Promise<boolean>;
};

const defaultTriggerPostMergeHookDeps: TriggerPostMergeHookDeps = {
  getUserSettings,
  getActiveHookForProject,
  getPostMergeHook,
  setupPostMergeHookSession,
  recordPostMergeHook,
  queuedCreateSession,
  finishPostMergeHook,
  patchPostMergeHook,
  registerAgentSession,
  cleanupPostMergeHookSession,
  killSession: proxyKillSession,
};

// Triggers a post-merge hook and returns immediately with an outcome
// describing whether one started. Callers that need to block until the hook
// finishes should additionally `await waitForPostMergeHook(run.id)` (see
// `runPostMergeHookGate` in session.ts).
//
// Empty prompt → skipped (no-op so callers can fire-and-await unconditionally).
// Toggle off (`postMergeHookEnabled === false`) → skipped, even with a prompt:
// the master switch lets a user pause the hook without losing their prompt.
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
  return triggerPostMergeHookWithDeps(options, defaultTriggerPostMergeHookDeps);
}

export async function triggerPostMergeHookWithDeps(
  options: TriggerPostMergeHookOptions,
  deps: TriggerPostMergeHookDeps,
): Promise<TriggerPostMergeHookOutcome> {
  // Mark intent synchronously, before the settings read. The Merge-step gate
  // watches this pre-record state so it cannot declare the project idle while
  // an uncached settings read is still preparing a hook.
  const endPending = beginPostMergeHookTrigger(options.projectPath);
  try {
    const prepared = await validateAndPrepare(options, deps);
    const outcome = prepared.kind === 'skip'
      ? prepared.outcome
      : await spawnAndRegister(options, deps, prepared);
    // The owed marker (owed.ts) is settled once a hook for these merges is
    // decided: one started, the user aborted it, or none is configured. Kept
    // on a spawn error (the next merge / boot retries) and, normally, on
    // `already-running`: that hook may predate these merges — or be a dead
    // record boot restored as running for its lost-grace window — so
    // `runPostMergeHookGate` waits it out and then fires a fresh one if the
    // debt is still there.
    //
    // Unless the running hook provably started AFTER the debt was recorded:
    // then it IS the hook for these merges. That is the backend dying between
    // the pty spawn and the clear above (or the clear failing): boot re-adopts
    // the live hook while the marker is still set, and without this the next
    // gate waited it out, saw the marker and fired a second hook for the same
    // merges.
    if (outcome.kind === 'skipped' && outcome.reason === 'already-running') {
      const since = await readPostMergeHookOwedSince(options.projectPath);
      if (since !== null && outcome.existing.startedAt >= since) {
        await clearPostMergeHookOwed(options.projectPath);
      }
    } else if (outcome.kind !== 'error') {
      await clearPostMergeHookOwed(options.projectPath);
    }
    return outcome;
  } finally {
    endPending();
  }
}

// Outcome of the validation phase: either a terminal skip outcome (empty
// prompt / master toggle off / hook already running) that the coordinator
// returns verbatim, or the prepared inputs the spawn phase needs.
type PreparedPostMergeHook =
  | { kind: 'skip'; outcome: TriggerPostMergeHookOutcome }
  | {
      kind: 'proceed';
      settings: UserSettings;
      prompt: string;
      harness: AgentHarness;
    };

// The gate half: resolve settings and run the three skip gates in order
// (no-prompt → disabled → already-running), then normalize the harness.
// No filesystem/spawn side effects — pure decision logic — so the coordinator
// can bail early without any cleanup.
async function validateAndPrepare(
  options: TriggerPostMergeHookOptions,
  deps: TriggerPostMergeHookDeps,
): Promise<PreparedPostMergeHook> {
  const { projectPath } = options;
  const settings = await deps.getUserSettings(projectPath);
  const prompt = (settings.postMergeHookPrompt ?? '').trim();
  if (!prompt) {
    return { kind: 'skip', outcome: { kind: 'skipped', reason: 'no-prompt' } };
  }
  // Master toggle: run only when explicitly enabled. Absent counts as enabled
  // so a previously-configured prompt keeps firing (see isPostMergeHookEnabled).
  if (settings.postMergeHookEnabled === false) {
    return { kind: 'skip', outcome: { kind: 'skipped', reason: 'disabled' } };
  }

  const existing = deps.getActiveHookForProject(projectPath);
  if (existing) {
    return {
      kind: 'skip',
      outcome: { kind: 'skipped', reason: 'already-running', existing },
    };
  }

  const harness = normalizeAgentHarness(settings.postMergeHookHarness);
  return { kind: 'proceed', settings, prompt, harness };
}

// The side-effecting half: reserve + record the run, set up its scratch
// session, build the command, spawn the pty, and register the agent-session
// node. Owns its own
// error cleanup so a failure at any step (thrown or a spawn `error` result)
// finishes the run `errored` (only once it's been recorded) and removes the
// scratch dir before returning the error outcome — preserving the original
// cleanup ordering.
async function spawnAndRegister(
  options: TriggerPostMergeHookOptions,
  deps: TriggerPostMergeHookDeps,
  prepared: Extract<PreparedPostMergeHook, { kind: 'proceed' }>,
): Promise<TriggerPostMergeHookOutcome> {
  const { projectPath, backendOrigin, trigger } = options;
  const { settings, prompt, harness } = prepared;

  // validateAndPrepare necessarily awaits settings. Two trigger calls can
  // therefore both pass its earlier active-run check before either resumes.
  // Re-check and synchronously record before the first await; this is the
  // atomic per-project claim in JavaScript's run-to-completion turn.
  const existing = deps.getActiveHookForProject(projectPath);
  if (existing) {
    return { kind: 'skipped', reason: 'already-running', existing };
  }

  const id = createPostMergeHookId();
  const cwd = assertSafePostMergeHookPath(projectPath, id);
  const run: PostMergeHookRun = {
    id,
    projectPath,
    harness,
    prompt,
    cwd,
    status: 'running',
    startedAt: Date.now(),
    trigger,
  };
  deps.recordPostMergeHook(run);

  // The run is recorded before either await below, so `/abort` can land while
  // scratch setup or the queued spawn is still in flight. Re-check after each:
  // without this the queued thunk created the pty anyway, `patch` emitted a
  // `progress` for a finished run, and `registerAgentSession` re-added the
  // orange node the abort had just removed.
  const abortedDuringLaunch = (): PostMergeHookRun | null => {
    const current = deps.getPostMergeHook(id);
    return current && current.status !== 'running' ? current : null;
  };

  try {
    const session = await deps.setupPostMergeHookSession({
      projectPath,
      backendOrigin,
      prompt,
      harness,
      id,
    });

    const abortedAfterSetup = abortedDuringLaunch();
    if (abortedAfterSetup) {
      // The abort's cleanup may have raced the scratch write; remove it again.
      await deps.cleanupPostMergeHookSession(projectPath, id);
      return { kind: 'skipped', reason: 'aborted', run: abortedAfterSetup };
    }

    // The run is already visible before scratch setup and pty creation, so the
    // workflow Merge-step gate cannot observe a false idle window here. The
    // waiter map is also in place if the harness curls /complete unusually
    // fast. The pty cwd is the scratch dir, matching pushRuns.
    // Claude reads `.claude/settings.local.json` (Stop hook) from cwd, and
    // Pi loads `.pi/extensions/` from cwd; running with cwd=projectPath would
    // miss both backstops and the merge run would hang waiting for a Stop
    // hook callback that never fires (this exact bug shipped in the first
    // cut). The agent cds into the project as its first step — see
    // renderPostMergeHookInstructions.
    const command = buildPostMergeHookCommand({
      harness,
      instructionsFile: session.instructionsFile,
      piModel:
        harness === 'pi' ? normalizePiModel(settings.postMergeHookPiModel) : undefined,
      // Codex `--yolo` toggle (default ON — only explicit `false` disables).
      codexYolo: harness === 'codex' ? settings.codexYolo !== false : undefined,
    });

    console.log(
      `[post-merge-hook] spawning ${harness} for run ${id} ` +
        `(trigger=${trigger}, cwd=${session.cwd}, prompt=${prompt.length}ch)`,
    );

    // `priority` band — the post-merge hook gates merge-run / manual-merge
    // completion, so it must not be starved behind batch task spawns.
    const sess = await deps.queuedCreateSession({
      kind: 'post-merge-hook',
      priority: 'priority',
      dedupeKey: `post-merge-hook:${projectPath}`,
      opts: {
        cwd: session.cwd,
        initialCommand: command,
        projectPath,
        registry: { owner: 'post-merge', label: `post-merge:${id.slice(-6)}` },
      },
    });

    if ('error' in sess) {
      // Spawn failed — mark the hook errored so anyone awaiting it unblocks.
      console.error(
        `[post-merge-hook] spawn failed for run ${id}: ${sess.error}`,
      );
      deps.finishPostMergeHook(id, 'errored', sess.error);
      await deps.cleanupPostMergeHookSession(projectPath, id);
      return { kind: 'error', message: sess.error };
    }

    const abortedAfterSpawn = abortedDuringLaunch();
    if (abortedAfterSpawn) {
      // The pty was created for a hook the user already aborted: reclaim it,
      // and neither record it (no `progress` event) nor register a node.
      try {
        await deps.killSession(sess.id);
      } catch {
        /* best-effort */
      }
      await deps.cleanupPostMergeHookSession(projectPath, id);
      return { kind: 'skipped', reason: 'aborted', run: abortedAfterSpawn };
    }

    const updated = deps.patchPostMergeHook(id, { serverId: sess.id, terminalId: sess.terminalId });
    // Presence: an orange agent node for this non-worktree session — any
    // harness (each reports activity through its own hooks; see stopHook.ts).
    deps.registerAgentSession({
      agentId: postMergeHookAgentId(id),
      projectPath,
      label: 'post-merge hook',
    });
    return { kind: 'started', run: updated ?? run, serverId: sess.id };
  } catch (err) {
    const message = (err as Error).message;
    console.error('[post-merge-hook] trigger failed:', err);
    deps.finishPostMergeHook(id, 'errored', message);
    await deps.cleanupPostMergeHookSession(projectPath, id);
    return { kind: 'error', message };
  }
}
