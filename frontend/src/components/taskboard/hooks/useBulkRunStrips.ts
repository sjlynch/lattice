import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '../../../api';

// The three lane-level bulk actions that spawn/transition tasks and so get a
// lightweight progress strip (mirroring the Ready-to-Merge MergeRunStrip):
//   open        → "Run all"  (enqueue a worktree run per Open task)
//   in_progress → "Resume all" (re-spawn each task with a worktree)
//   qa          → "Mark all done"
export type BulkStripLane = 'open' | 'in_progress' | 'qa';
export type BulkKind = 'run' | 'resume' | 'qa-done';

// What the strip component renders: live progress counts + phase.
export type BulkStripView = {
  kind: BulkKind;
  phase: 'active' | 'done';
  total: number;
  // run: tasks that left the Open lane / qa-done: tasks that left QA /
  // resume: tasks we've seen a `task-spawned` event for.
  spawned: number;
  // run only: tasks accepted into the backend spawn queue (runQueued) but not
  // yet spawned. resume/qa-done never queue-visibly, so this stays 0.
  queued: number;
};

type BulkStripRecord = {
  lane: BulkStripLane;
  kind: BulkKind;
  // Task ids targeted at click time — progress is measured against this set.
  ids: string[];
  total: number;
  // resume only: ids delivered via the `task-spawned` WS event.
  spawnedIds: Set<string>;
  phase: 'active' | 'done';
};

type LaneTimers = {
  // Backstop: a task that errors back to plain Open (or a resume that never
  // spawns) would otherwise leave the strip spinning forever.
  safety?: ReturnType<typeof setTimeout>;
  dismiss?: ReturnType<typeof setTimeout>;
};

const SAFETY_MS = 12000;
const DISMISS_MS = 5000;

const BULK_LANES: BulkStripLane[] = ['open', 'in_progress', 'qa'];

// Classify each targeted task as spawned / queued / still-pending from the
// live task list (resume has no task-state signal, so it rides spawnedIds).
function deriveCounts(rec: BulkStripRecord, byId: Map<string, Task>) {
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

// Per-lane progress strips for the Open / In Progress / QA bulk actions. The
// active strip clears as soon as every targeted task has been spawned or
// accepted into the queue; it then flips to a short auto-dismissing summary.
export function useBulkRunStrips(tasks: Task[]) {
  const [records, setRecords] = useState<
    Partial<Record<BulkStripLane, BulkStripRecord>>
  >({});
  const timersRef = useRef<Partial<Record<BulkStripLane, LaneTimers>>>({});

  const dismissBulk = useCallback((lane: BulkStripLane) => {
    const t = timersRef.current[lane];
    if (t?.safety) clearTimeout(t.safety);
    if (t?.dismiss) clearTimeout(t.dismiss);
    timersRef.current[lane] = {};
    setRecords((prev) => {
      if (!prev[lane]) return prev;
      const next = { ...prev };
      delete next[lane];
      return next;
    });
  }, []);

  // Flip a still-active strip to its summary phase and arm the auto-dismiss.
  const finish = useCallback(
    (lane: BulkStripLane) => {
      const t = (timersRef.current[lane] ??= {});
      if (t.safety) {
        clearTimeout(t.safety);
        t.safety = undefined;
      }
      setRecords((prev) => {
        const rec = prev[lane];
        if (!rec || rec.phase === 'done') return prev;
        return { ...prev, [lane]: { ...rec, phase: 'done' } };
      });
      if (t.dismiss) clearTimeout(t.dismiss);
      t.dismiss = setTimeout(() => dismissBulk(lane), DISMISS_MS);
    },
    [dismissBulk],
  );

  const beginBulk = useCallback(
    (lane: BulkStripLane, ids: string[], kind: BulkKind) => {
      const t = (timersRef.current[lane] ??= {});
      if (t.safety) clearTimeout(t.safety);
      if (t.dismiss) clearTimeout(t.dismiss);
      timersRef.current[lane] = {};
      if (ids.length === 0) {
        // Nothing to do (button is disabled for empty lanes anyway) — make
        // sure no stale strip lingers.
        setRecords((prev) => {
          if (!prev[lane]) return prev;
          const next = { ...prev };
          delete next[lane];
          return next;
        });
        return;
      }
      setRecords((prev) => ({
        ...prev,
        [lane]: {
          lane,
          kind,
          ids: [...ids],
          total: ids.length,
          spawnedIds: new Set(),
          phase: 'active',
        },
      }));
      timersRef.current[lane] = {
        safety: setTimeout(() => finish(lane), SAFETY_MS),
      };
    },
    [finish],
  );

  // Resume has no task-state change to observe, so its completion rides the
  // `task-spawned` WS event (delivered from the launcher's spawn handler).
  const noteBulkSpawned = useCallback((taskId: string) => {
    setRecords((prev) => {
      const rec = prev.in_progress;
      if (
        !rec ||
        rec.phase !== 'active' ||
        !rec.ids.includes(taskId) ||
        rec.spawnedIds.has(taskId)
      ) {
        return prev;
      }
      const spawnedIds = new Set(rec.spawnedIds);
      spawnedIds.add(taskId);
      return { ...prev, in_progress: { ...rec, spawnedIds } };
    });
  }, []);

  const byId = useMemo(
    () => new Map(tasks.map((t) => [t.id, t] as const)),
    [tasks],
  );

  // Complete a strip once every targeted task has left its lane / been queued
  // (run, qa-done) or spawned (resume).
  useEffect(() => {
    for (const lane of BULK_LANES) {
      const rec = records[lane];
      if (!rec || rec.phase !== 'active') continue;
      if (deriveCounts(rec, byId).pending === 0) finish(lane);
    }
  }, [records, byId, finish]);

  // Clear any pending timers on unmount (folder switch / panel close).
  useEffect(
    () => () => {
      for (const lane of BULK_LANES) {
        const t = timersRef.current[lane];
        if (t?.safety) clearTimeout(t.safety);
        if (t?.dismiss) clearTimeout(t.dismiss);
      }
    },
    [],
  );

  const bulkStrips = useMemo(() => {
    const out: Partial<Record<BulkStripLane, BulkStripView>> = {};
    for (const lane of BULK_LANES) {
      const rec = records[lane];
      if (!rec) continue;
      const { spawned, queued } = deriveCounts(rec, byId);
      out[lane] = { kind: rec.kind, phase: rec.phase, total: rec.total, spawned, queued };
    }
    return out;
  }, [records, byId]);

  return { bulkStrips, beginBulk, noteBulkSpawned, dismissBulk };
}
