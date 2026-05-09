// Shared internal helpers used by more than one of the split task route
// modules. Anything used by only one module stays in that module.

import type { finalizeMergedTask } from '../../worktree.js';

// finalizeMergedTask now lives in worktree.ts so it's reachable from the
// merge-run worker too. Convert its discriminated outcome to a flat
// message string for HTTP responses.
export function finalizeError(
  fin: Extract<
    Awaited<ReturnType<typeof finalizeMergedTask>>,
    { ok: false }
  >,
): string {
  if ('error' in fin) return fin.error;
  return `Stash-pop conflict on ${fin.stashConflict.length} file(s) — Claude resolver spawned`;
}
