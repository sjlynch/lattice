export type OptimisticSaveDeps<T> = {
  // PATCH the value to the backend.
  persist: (value: T) => Promise<unknown>;
  // Put a value on screen (and into whatever ref the hook reads it back from).
  apply: (value: T) => void;
  // True while this save is still the latest word on the value, in the same
  // project load. A later toggle supersedes it (that save's own outcome settles
  // the UI), and so does a project switch (the revert would land on the wrong
  // project's form).
  isCurrent: () => boolean;
  // The value to restore when the save fails, read AT FAILURE TIME: the last
  // value the backend loaded or acknowledged. Read lazily so an earlier save
  // that succeeded while this one was in flight is what the UI falls back to.
  previous: () => T;
  // The backend now holds `value`.
  onSaved?: (value: T) => void;
  onError: (err: unknown) => void;
  // Runs after either outcome — the hooks' in-flight save counter.
  onSettled?: () => void;
};

// Optimistic settings save: show `next` at once, PATCH it, and on failure put
// the previous value back so the control never reads a state the backend
// doesn't hold (a QA Globe showing "on" while the next QA run spawns without
// Playwright; a post-merge switch reading "Off" while the hook still fires).
// Resolves true when the save landed.
export async function saveOptimistic<T>(next: T, deps: OptimisticSaveDeps<T>): Promise<boolean> {
  deps.apply(next);
  try {
    await deps.persist(next);
  } catch (err) {
    if (deps.isCurrent()) deps.apply(deps.previous());
    deps.onError(err);
    return false;
  } finally {
    deps.onSettled?.();
  }
  deps.onSaved?.(next);
  return true;
}
