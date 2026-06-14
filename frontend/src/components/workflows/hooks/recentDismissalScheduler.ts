// Small timer manager for the recent-run linger. Keeps the setTimeout
// bookkeeping (one pending timer per run id, replace-on-reschedule, cancel-all
// on cleanup) out of the hook effect. The delay policy itself is the pure
// `recentDismissalDelayMs` in `workflowRunSync.ts`.

import type { WorkflowRunStatus } from '../../../api';
import { recentDismissalDelayMs } from './workflowRunSync';

export type RecentDismissalScheduler = {
  // Schedule (or reschedule) the deferred dismissal of `id` with a
  // status-dependent delay. A pending timer for the same id is replaced.
  schedule: (id: string, status: WorkflowRunStatus) => void;
  // Clear every pending timer — call on effect cleanup so no dismissal fires
  // after the subscription is torn down / activeFolder changes.
  cancelAll: () => void;
};

export function createRecentDismissalScheduler(
  onDismiss: (id: string) => void,
): RecentDismissalScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(id, status) {
      const prev = timers.get(id);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        timers.delete(id);
        onDismiss(id);
      }, recentDismissalDelayMs(status));
      timers.set(id, t);
    },
    cancelAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
