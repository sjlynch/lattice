import type { Task, TaskStatus } from '../../api';

// The three lane-level bulk actions that spawn/transition tasks and so get a
// lightweight progress strip (mirroring the Ready-to-Merge MergeRunStrip):
//   open        → "Run all"  (enqueue a worktree run per Open task)
//   in_progress → "Resume all" (re-spawn each task with a worktree)
//   qa          → "Mark all done"
export type BulkStripLane = 'open' | 'in_progress' | 'qa';
export type BulkKind = 'run' | 'resume' | 'qa-done';

export type BulkStripRecord = {
  lane: BulkStripLane;
  kind: BulkKind;
  // Task ids targeted at click time — progress is measured against this set.
  ids: string[];
  total: number;
  // resume only: ids delivered via the `task-spawned` WS event.
  spawnedIds: Set<string>;
  phase: 'active' | 'done';
};

// Classify each targeted task as spawned / queued / still-pending from the
// live task list (resume has no task-state signal, so it rides spawnedIds).
export function deriveCounts(rec: BulkStripRecord, byId: Map<string, Task>) {
  let spawned = 0;
  let queued = 0;
  let pending = 0;
  for (const id of rec.ids) {
    if (rec.kind === 'resume') {
      if (rec.spawnedIds.has(id)) spawned++;
      else pending++;
      continue;
    }
    const task = byId.get(id);
    const homeLane: TaskStatus = rec.kind === 'run' ? 'open' : 'qa';
    if (!task || task.status !== homeLane) {
      spawned++; // left its lane → the action took effect for this task
    } else if (rec.kind === 'run' && task.runQueued) {
      queued++; // accepted by the spawn queue, badge now shows on the card
    } else {
      pending++; // request still in flight (or errored back to Open)
    }
  }
  return { spawned, queued, pending };
}
