import type { MergeRun } from './types.js';
import type { WaiterReleaseReason } from './waiterLiveness.js';

export function preserveResolverAfterWaitFailure(run: MergeRun, taskId: string, reason: Exclude<WaiterReleaseReason, 'signalled'>): void {
  // The waiter dropped its task lock. Even confirmed death can race a late
  // completion or replacement resolver; aborting here would overwrite their
  // work. Preserve all conflicts and stop. A later merge retry re-probes and
  // reattaches or replaces the resolver under the normal merge ownership path.
  run.cancelRequested = true;
  run.errored.push({ taskId, error: `Resolver ${reason}; worktree, terminal, and conflict were preserved. Inspect the resolver and retry Merge to continue.` });
}
