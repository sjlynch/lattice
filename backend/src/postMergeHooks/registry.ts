import { canonicalProjectPath } from '../projectPath.js';
import type { PostMergeHookRun, PostMergeHookStatus } from './types.js';

// In-memory registry of post-merge hook runs.
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

type Waiter = {
  resolve: () => void;
};

type Entry = {
  run: PostMergeHookRun;
  waiters: Waiter[];
};

const entries = new Map<string, Entry>();

// A trigger must read settings before it can construct the full run record.
// Keep that pre-record launch window visible to the workflow Merge-step gate;
// otherwise Phase C can observe "idle" while a hook is already starting.
const pendingTriggerCounts = new Map<string, number>();
type TriggerListener = (projectPath: string) => void;
const triggerListeners = new Set<TriggerListener>();

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

export function beginPostMergeHookTrigger(projectPath: string): () => void {
  const key = canonicalProjectPath(projectPath);
  pendingTriggerCounts.set(key, (pendingTriggerCounts.get(key) ?? 0) + 1);
  for (const fn of triggerListeners) {
    try {
      fn(key);
    } catch (err) {
      console.error('[post-merge-hook] trigger listener threw:', err);
    }
  }

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (pendingTriggerCounts.get(key) ?? 1) - 1;
    if (remaining > 0) pendingTriggerCounts.set(key, remaining);
    else pendingTriggerCounts.delete(key);
    for (const fn of triggerListeners) {
      try {
        fn(key);
      } catch (err) {
        console.error('[post-merge-hook] trigger listener threw:', err);
      }
    }
  };
}

export function hasPendingPostMergeHookTrigger(projectPath: string): boolean {
  return (pendingTriggerCounts.get(canonicalProjectPath(projectPath)) ?? 0) > 0;
}

export function subscribePostMergeHookTriggers(fn: TriggerListener): () => void {
  triggerListeners.add(fn);
  return () => {
    triggerListeners.delete(fn);
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
  notify({ type: 'started', run: { ...canonicalRun } });
}

function pruneHistoryFor(projectPath: string, keepId: string): void {
  const key = canonicalProjectPath(projectPath);
  const forProject = [...entries.entries()]
    .filter(([, e]) => e.run.projectPath === key)
    .sort((a, b) => (b[1].run.startedAt - a[1].run.startedAt));
  let kept = 0;
  for (const [id, e] of forProject) {
    if (id === keepId) {
      kept += 1;
      continue;
    }
    if (e.run.status === 'running') {
      kept += 1;
      continue;
    }
    kept += 1;
    if (kept > MAX_HISTORY_PER_PROJECT) entries.delete(id);
  }
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
  const waiters = e.waiters.splice(0);
  for (const w of waiters) w.resolve();
  notify({ type: 'finished', run: { ...e.run } });
  return { ...e.run };
}

// Promise that resolves when the hook reaches a terminal status. Used by
// callers (merge run finisher, per-task finalize) to block their own
// completion until the harness reports done.
export function waitForPostMergeHook(id: string): Promise<void> {
  const e = entries.get(id);
  if (!e) return Promise.resolve();
  if (e.run.status !== 'running') return Promise.resolve();
  return new Promise<void>((resolve) => {
    e.waiters.push({ resolve });
  });
}
