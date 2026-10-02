import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../../../api';
import type {
  BulkKind,
  BulkStripLane,
  BulkStripRecord,
} from '../bulkStripProgress';
import { deriveCounts } from '../bulkStripProgress';

// Re-exported here so consumers keep importing the bulk-strip vocabulary from
// this hook; the pure classifier + record shape now live in bulkStripProgress.
export type { BulkStripLane, BulkKind } from '../bulkStripProgress';

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

type LaneTimers = {
  // Backstop: a task that errors back to plain Open (or a resume that never
  // spawns) would otherwise leave the strip spinning forever.
  safety?: ReturnType<typeof setTimeout>;
  dismiss?: ReturnType<typeof setTimeout>;
};

// Force a strip stuck in its active phase to flip to its summary, so a task
// that errors back to Open (or a resume that never spawns) can't spin forever.
const SAFETY_MS = 12000;
// How long the done-phase "Started N tasks" summary lingers before it clears.
const DISMISS_MS = 5000;

const BULK_LANES: BulkStripLane[] = ['open', 'in_progress', 'qa'];

// Shared, never-mutated stand-in for `byId` while no strip record exists.
const NO_TASKS = new Map<string, Task>();

// Per-lane progress strips for the Open / In Progress / QA bulk actions. The
// active strip clears as soon as every targeted task has been spawned or
// accepted into the queue; it then flips to a short auto-dismissing summary.
//
// Strips are per project: the launcher stays mounted across project switches,
// so a switch drops every record and lane timer. Otherwise project A's ids —
// absent from B's (initially empty) task list — would read as spawned and flash
// "Started N tasks" on B, and an A resume would spin on B until SAFETY_MS since
// A's `task-spawned` events stop arriving.
export function useBulkRunStrips(activeFolder: string, tasks: Task[]) {
  const [records, setRecords] = useState<
    Partial<Record<BulkStripLane, BulkStripRecord>>
  >({});
  const timersRef = useRef<Partial<Record<BulkStripLane, LaneTimers>>>({});

  // Reset during render (not in an effect) so the first render under the new
  // folder never derives strips — or fires `finish` — from the old records.
  const [recordsFolder, setRecordsFolder] = useState(activeFolder);
  if (recordsFolder !== activeFolder) {
    setRecordsFolder(activeFolder);
    setRecords({});
  }

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

  // Only strip records read `byId`, so skip indexing the whole board on every
  // task update while no strip is showing. Flipping `hasRecords` rebuilds it
  // from the current tasks before any record is classified.
  const hasRecords = BULK_LANES.some((lane) => records[lane]);
  const byId = useMemo(
    () =>
      hasRecords ? new Map(tasks.map((t) => [t.id, t] as const)) : NO_TASKS,
    [hasRecords, tasks],
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

  // Clear every pending lane timer on a folder switch or unmount, so no old
  // project's safety/dismiss timer fires into the next project's strips.
  useEffect(
    () => () => {
      for (const lane of BULK_LANES) {
        const t = timersRef.current[lane];
        if (t?.safety) clearTimeout(t.safety);
        if (t?.dismiss) clearTimeout(t.dismiss);
      }
      timersRef.current = {};
    },
    [activeFolder],
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
