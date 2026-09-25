import { canonicalProjectPath } from '../projectPath.js';
import { normalizeAgentHarness } from '../harnesses.js';
import {
  createOneOffRunStore,
  readNumber,
  readRunningRecordIdentity,
  readString,
} from '../homeScratch/persistence.js';
import { postMergeHookPaths } from './paths.js';
import type { PostMergeHookRun, PostMergeHookStatus } from './types.js';

export {
  beginPostMergeHookTrigger,
  hasPendingPostMergeHookTrigger,
  subscribePostMergeHookTriggers,
} from './pendingTriggers.js';

// In-memory registry of post-merge hook runs (the running ones are also
// mirrored to disk for restart recovery — see "Durable mirror" below).
//
// Only one running hook per project is allowed (enforced by callers via
// `getActiveHookForProject`). A handful of finished hooks are kept around so
// the UI can render the most-recent result, but the map is pruned to a small
// bounded size on every insert so it can't grow without bound.
//
// We also expose a per-project promise waiter: the merge-run finisher and the
// per-task finalize path both `await waitForHook(id)` after triggering the
// hook so they block their own "completed" state until the harness reports
// done. The promise is resolved by the /complete and /abort routes.

const MAX_HISTORY_PER_PROJECT = 5;
// `waitForPostMergeHook`'s expiry message states a wait this long or longer in
// minutes, a shorter one in ms.
const FORMAT_AS_MINUTES_MS = 60_000;

type Waiter = {
  resolve: () => void;
};

type Entry = {
  run: PostMergeHookRun;
  waiters: Waiter[];
};

const entries = new Map<string, Entry>();

// ---------------------------------------------------------------------------
// Durable mirror of the RUNNING hooks (`~/.lattice/per-project/<hash>/
// post-merge-hooks.json`, see ../homeScratch/persistence.ts). The hook's agent
// lives in the detached terminal-server and survives a backend restart; the
// merge run that fired it is re-run by boot recovery. Without the mirror the
// resumed run could not see the still-running hook — it fired a SECOND one, or
// (its merges already done) the workflow Merge step's Phase C read "idle" while
// the orphan kept working, and the orphan's `/complete` 404'd. Boot recovery
// (`recovery/oneOffRunResume.ts`) restores a hook whose pty is alive, so the
// one-running-per-project gate, the waiters and the UI all see it again.
// ---------------------------------------------------------------------------

export const POST_MERGE_HOOKS_FILENAME = 'post-merge-hooks.json';

export function deserializePostMergeHook(
  raw: unknown,
  owningProject: string,
): PostMergeHookRun | null {
  // `cwd` is re-derived through the scratch path guard from the regex-checked
  // id — recovery matches the live pty by it and cleanup deletes it.
  const identity = readRunningRecordIdentity(raw, owningProject, postMergeHookPaths);
  if (!identity) return null;
  const { record: r, id, projectPath, cwd } = identity;
  const run: PostMergeHookRun = {
    id,
    projectPath,
    harness: normalizeAgentHarness(r.harness),
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    cwd,
    status: 'running',
    startedAt: readNumber(r.startedAt) ?? 0,
    trigger: r.trigger === 'manual-merge' ? 'manual-merge' : 'merge-run',
  };
  const serverId = readString(r.serverId);
  if (serverId) run.serverId = serverId;
  const terminalId = readString(r.terminalId);
  if (terminalId) run.terminalId = terminalId;
  const stopReceivedAt = readNumber(r.stopReceivedAt);
  if (stopReceivedAt !== undefined) run.stopReceivedAt = stopReceivedAt;
  const stopActiveAt = readNumber(r.stopActiveAt);
  if (stopActiveAt !== undefined) run.stopActiveAt = stopActiveAt;
  if (typeof r.stopBusy === 'boolean') run.stopBusy = r.stopBusy;
  return run;
}

export const postMergeHookStore = createOneOffRunStore<PostMergeHookRun>({
  fileName: POST_MERGE_HOOKS_FILENAME,
  logLabel: '[post-merge-hook]',
  deserialize: deserializePostMergeHook,
});

function persistProject(projectPath: string): void {
  const key = canonicalProjectPath(projectPath);
  postMergeHookStore.persist(key, () =>
    [...entries.values()]
      .filter((e) => e.run.projectPath === key && e.run.status === 'running')
      .map((e) => ({ ...e.run })),
  );
}

// Boot recovery: put a persisted still-running hook back (no-op if the id is
// already tracked). Emits `started` so a subscriber already watching the
// project (the Merge step's Phase C, the WS endpoint) re-evaluates.
export function restorePostMergeHook(run: PostMergeHookRun): boolean {
  if (entries.has(run.id)) return false;
  const canonicalRun = {
    ...run,
    status: 'running' as const,
    projectPath: canonicalProjectPath(run.projectPath),
  };
  entries.set(canonicalRun.id, { run: canonicalRun, waiters: [] });
  notify({ type: 'started', run: { ...canonicalRun } });
  return true;
}

export type PostMergeHookEvent =
  | { type: 'started'; run: PostMergeHookRun }
  | { type: 'progress'; run: PostMergeHookRun }
  | { type: 'finished'; run: PostMergeHookRun };

type Listener = (event: PostMergeHookEvent) => void;
const listeners = new Set<Listener>();

function notify(event: PostMergeHookEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('[post-merge-hook] listener threw:', err);
    }
  }
}

export function subscribePostMergeHooks(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function recordPostMergeHook(run: PostMergeHookRun): void {
  // Lookups canonicalize their query, so the stored side must do the same or
  // a path variant (notably a lower-case Windows drive) makes a live hook
  // invisible to the workflow Merge-step gate.
  const canonicalRun = {
    ...run,
    projectPath: canonicalProjectPath(run.projectPath),
  };
  entries.set(canonicalRun.id, { run: canonicalRun, waiters: [] });
  pruneHistoryFor(canonicalRun.projectPath, canonicalRun.id);
  persistProject(canonicalRun.projectPath);
  notify({ type: 'started', run: { ...canonicalRun } });
}

function pruneHistoryFor(projectPath: string, keepId: string): void {
  const key = canonicalProjectPath(projectPath);
  const forProject = [...entries.entries()]
    .filter(([, e]) => e.run.projectPath === key)
    .sort((a, b) => (b[1].run.startedAt - a[1].run.startedAt));
  // Newest first; everything past the first MAX_HISTORY_PER_PROJECT goes,
  // except the just-recorded run and any still-running one.
  forProject.slice(MAX_HISTORY_PER_PROJECT).forEach(([id, e]) => {
    if (id !== keepId && e.run.status !== 'running') entries.delete(id);
  });
}

export function getPostMergeHook(id: string): PostMergeHookRun | null {
  const e = entries.get(id);
  return e ? { ...e.run } : null;
}

export function getActiveHookForProject(
  projectPath: string,
): PostMergeHookRun | null {
  const key = canonicalProjectPath(projectPath);
  for (const e of entries.values()) {
    if (e.run.projectPath === key && e.run.status === 'running') {
      return { ...e.run };
    }
  }
  return null;
}

export function getMostRecentHookForProject(
  projectPath: string,
): PostMergeHookRun | null {
  const key = canonicalProjectPath(projectPath);
  let best: PostMergeHookRun | null = null;
  for (const e of entries.values()) {
    if (e.run.projectPath !== key) continue;
    if (!best || e.run.startedAt > best.startedAt) best = { ...e.run };
  }
  return best;
}

export function patchPostMergeHook(
  id: string,
  patch: Partial<PostMergeHookRun>,
): PostMergeHookRun | null {
  const e = entries.get(id);
  if (!e) return null;
  e.run = { ...e.run, ...patch };
  persistProject(e.run.projectPath);
  notify({ type: 'progress', run: { ...e.run } });
  return { ...e.run };
}

export function finishPostMergeHook(
  id: string,
  status: Exclude<PostMergeHookStatus, 'running'>,
  error?: string,
): PostMergeHookRun | null {
  const e = entries.get(id);
  if (!e) return null;
  if (e.run.status !== 'running') {
    // Idempotent; just return current state.
    return { ...e.run };
  }
  e.run.status = status;
  e.run.finishedAt = Date.now();
  if (error) e.run.error = error;
  // Drops it from the mirror straight away: a restart that re-read it as
  // running would re-adopt a hook whose `/complete` has already been spent.
  persistProject(e.run.projectPath);
  const waiters = e.waiters.splice(0);
  for (const w of waiters) w.resolve();
  notify({ type: 'finished', run: { ...e.run } });
  return { ...e.run };
}

// The still-running hook whose pty is `serverId`, if any. Lets a terminal-tab
// close (DELETE /api/terminals/:id) end the hook the pty belonged to, so the
// merge run / workflow Merge step waiting on it isn't parked forever.
export function getActiveHookForServerId(
  serverId: string,
): PostMergeHookRun | null {
  for (const e of entries.values()) {
    if (e.run.status === 'running' && e.run.serverId === serverId) {
      return { ...e.run };
    }
  }
  return null;
}

// Promise that resolves when the hook reaches a terminal status. Used by
// callers (merge run finisher, per-task finalize) to block their own
// completion until the harness reports done.
//
// Nothing observes the hook's pty: an agent that crashes, is killed, or whose
// tab is closed without the abort route never calls back, and an unbounded
// wait here kept the merge run `running` (run.lock held, a workflow Merge step
// parked in `waitForMergeRunFinished`) forever. With `maxWaitMs` the wait
// expires by finishing the hook `errored` — which resolves every waiter the
// usual way — and reports `'expired'` so the caller can tear the session down.
export function waitForPostMergeHook(
  id: string,
  maxWaitMs?: number,
): Promise<'finished' | 'expired'> {
  const e = entries.get(id);
  if (!e) return Promise.resolve('finished');
  if (e.run.status !== 'running') return Promise.resolve('finished');
  return new Promise<'finished' | 'expired'>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const waiter: Waiter = {
      resolve: () => {
        if (timer) clearTimeout(timer);
        resolve('finished');
      },
    };
    e.waiters.push(waiter);
    if (maxWaitMs !== undefined && maxWaitMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (e.run.status !== 'running') return;
        const within =
          maxWaitMs >= FORMAT_AS_MINUTES_MS
            ? `${Math.round(maxWaitMs / FORMAT_AS_MINUTES_MS)} minutes`
            : `${maxWaitMs} ms`;
        console.warn(
          `[post-merge-hook] ${id} did not call back within ${within} — finishing it errored`,
        );
        // Detach this waiter first: the finish below resolves the OTHER
        // waiters 'finished'; this one reports 'expired'.
        const idx = e.waiters.indexOf(waiter);
        if (idx >= 0) e.waiters.splice(idx, 1);
        finishPostMergeHook(
          id,
          'errored',
          `post-merge hook did not call back within ${within}`,
        );
        resolve('expired');
      }, maxWaitMs);
      timer.unref?.();
    }
  });
}
