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

// Record the resolved terminal auto-close decision (from
// UserSettings.qaTerminalAutoClose) so the frontend poller can mirror it when
// it next sees `done`. No-op if the run is unknown.
export function recordQaRunAutoClose(id: string, autoClose: boolean): void {
  const r = runs.get(id);
  if (r) r.autoCloseTerminal = autoClose;
}

// Forget the run once the frontend has acknowledged completion — keeps the
// in-memory map from growing across long sessions.
//
// IMPORTANT: never drop a run that is still `running`. The frontend status
// poller calls this (via DELETE /api/qa-runs/:id) whenever a single
// `GET /api/qa-runs/:id` poll fails or 404s — and a *transient* fetch hiccup is
// indistinguishable from "the run is gone". Honoring that for a live run would
// delete it from the registry before the agent posts its verdict, so the later
// /verdict callback finds no run (`tracked:false`) and the confident-PASS
// auto-advance qa → done silently never happens (the exact bug that left a
// passed task stuck in the QA lane). A live run is only ever forgotten after
// its Stop hook has marked it `done`; an unknown id is a harmless no-op.
export function forgetQaRun(id: string): void {
  const r = runs.get(id);
  if (r && r.status !== 'done') return;
  runs.delete(id);
}
