import path from 'node:path';
import fs from 'node:fs/promises';
import { homeProjectDir } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import type { LockBody } from './types.js';

// Run-lock labels whose stale (dead-PID) presence means orphaned merge work
// that boot recovery should drain by starting a fresh merge run:
//
//   - `merge-run`            — a backend-driven "merge all" run died mid-flight.
//   - `workflow-merge:<id>`  — a WORKFLOW run's Merge control step died. This is
//                              the important addition: a workflow's Merge step
//                              holds the per-project run-lock while it drains
//                              In-Progress (Phase A) and merges Ready-to-Merge
//                              (Phase B). If the backend is killed during that
//                              window (a crash, or a dev `tsc -w` restart in a
//                              lock-free instant), the step's `finally` never
//                              runs — so the lock is left behind AND the tasks
//                              the workflow started sit in `ready_to_merge`,
//                              never merged. Pre-fix, boot recovery matched only
//                              `merge-run` and skipped this, stranding the tasks
//                              (observed: a `start → merge → push` workflow that
//                              left 25 completed-but-unmerged tasks after its
//                              Merge step's process died — its stale lock read
//                              `workflow-merge:...`).
//   - `workflow-push:<id>`   — a workflow's Push control step died. It normally
//                              runs after Merge drained the lane, so there is
//                              usually nothing to do; included so a Push-time
//                              death that left a stray `ready_to_merge` task
//                              still recovers. Gated on pending work below, so
//                              it is a no-op otherwise.
//
// A manual `/merge` (`manual-merge`) and a workflow `Start` (`workflow-start:*`)
// are deliberately NOT resumed here: the former is a single-task op with its own
// recovery, the latter dies before tasks reach `ready_to_merge` (its orphans are
// in_progress and handled by the in-progress sweep). Nor is a workflow Run tests
// step (`workflow-test:*`): it merges nothing — its run is re-adopted by
// `resumeInterruptedWorkflowRuns`, which re-takes that lock itself. Everything
// the merge-run resume does is additionally gated on `ready_to_merge` tasks
// actually existing, so a mismatch is at worst a no-op.
//
// Lives here (not in recovery/mergeRunResume.ts, which re-exports it) so boot
// snapshot recovery can use it without importing the merge-run engine.
export function isResumableInterruptedRunLock(label: string): boolean {
  return (
    label === 'merge-run' ||
    label.startsWith('workflow-merge:') ||
    label.startsWith('workflow-push:')
  );
}

// The record of an interrupted run whose dead lock something other than the
// resume retired. Boot snapshot recovery runs BEFORE the merge-run resume and
// has to take the project run lock to restore a pending snapshot — stealing
// and retiring a dead `merge-run` lock on the way. The resume, which reads the
// lock to learn that a Merge All was interrupted, then found none and left the
// `ready_to_merge` tasks stranded; the owed post-merge hook check likewise
// stopped seeing the interrupted merge and could fire mid-merge. Recovery
// writes this marker before stealing, and both consult it when the lock is
// gone. Durable (not boot-scoped), so a crash between the two steps still
// resumes on the next boot; the resume clears it once it has acted.
export type InterruptedRunMarker = Pick<LockBody, 'label' | 'pid' | 'hostname' | 'startedAt'> & {
  recordedAt: number;
};

const MARKER_FILENAME = 'interrupted-run.json';

export function interruptedRunMarkerPath(projectPath: string): string {
  return path.join(homeProjectDir(projectPath), MARKER_FILENAME);
}

export async function recordInterruptedRun(projectPath: string, holder: LockBody): Promise<void> {
  const marker: InterruptedRunMarker = {
    label: holder.label,
    pid: holder.pid,
    hostname: holder.hostname,
    startedAt: holder.startedAt,
    recordedAt: Date.now(),
  };
  const file = interruptedRunMarkerPath(projectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, JSON.stringify(marker, null, 2));
}

export async function readInterruptedRun(projectPath: string): Promise<InterruptedRunMarker | null> {
  try {
    const value = JSON.parse(await fs.readFile(interruptedRunMarkerPath(projectPath), 'utf8')) as Partial<InterruptedRunMarker>;
    if (
      typeof value.label !== 'string' || !isResumableInterruptedRunLock(value.label)
      || typeof value.pid !== 'number' || typeof value.startedAt !== 'number'
    ) return null;
    return {
      label: value.label,
      pid: value.pid,
      hostname: typeof value.hostname === 'string' ? value.hostname : '',
      startedAt: value.startedAt,
      recordedAt: typeof value.recordedAt === 'number' ? value.recordedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function clearInterruptedRun(projectPath: string): Promise<void> {
  await fs.rm(interruptedRunMarkerPath(projectPath), { force: true });
}
