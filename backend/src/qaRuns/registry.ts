import type { QaRun, QaVerdict } from './types.js';

// In-memory QA e2e-run registry. Like pushRuns, it isn't persisted — at boot
// the map is empty, so any scratch dir still on disk is by definition stale
// (the boot sweep reclaims it).
const runs = new Map<string, QaRun>();

export function getQaRun(id: string): QaRun | undefined {
  return runs.get(id);
}

export function recordQaRun(run: QaRun): void {
  runs.set(run.id, run);
}

export function markQaRunDone(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status === 'done') return false;
  r.status = 'done';
  r.doneAt = Date.now();
  return true;
}

// Stash the agent's reported verdict on the run. No-op if the run is unknown.
export function recordQaVerdict(id: string, verdict: QaVerdict): void {
  const r = runs.get(id);
  if (r) r.verdict = verdict;
}

// Flag that a confident pass promoted this run's task to Done.
export function markQaRunMovedToDone(id: string): void {
  const r = runs.get(id);
  if (r) r.movedToDone = true;
}

// Forget the run once the frontend has acknowledged completion — keeps the
// in-memory map from growing across long sessions.
export function forgetQaRun(id: string): void {
  runs.delete(id);
}
