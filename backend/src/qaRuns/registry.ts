import { createOneOffRunRegistry } from '../homeScratch/registry.js';
import type { QaRun, QaVerdict } from './types.js';

// In-memory QA e2e-run registry. Like pushRuns, it isn't persisted — at boot
// the map is empty, so any scratch dir still on disk is by definition stale
// (the boot sweep reclaims it).
const registry = createOneOffRunRegistry<QaRun>({
  logLabel: '[qaRuns]',
});

export function getQaRun(id: string): QaRun | undefined {
  return registry.get(id);
}

export function recordQaRun(run: QaRun): void {
  registry.record(run);
}

export function markQaRunDone(id: string): boolean {
  return registry.markDone(id);
}

// Stash the agent's reported verdict on the run. No-op if the run is unknown.
export function recordQaVerdict(id: string, verdict: QaVerdict): void {
  const r = registry.get(id);
  if (r) r.verdict = verdict;
}

// Flag that a confident pass promoted this run's task to Done.
export function markQaRunMovedToDone(id: string): void {
  const r = registry.get(id);
  if (r) r.movedToDone = true;
}

// Record the resolved terminal auto-close decision (from
// UserSettings.qaTerminalAutoClose) so the frontend poller can mirror it when
// it next sees `done`. No-op if the run is unknown.
export function recordQaRunAutoClose(id: string, autoClose: boolean): void {
  const r = registry.get(id);
  if (r) r.autoCloseTerminal = autoClose;
}

// Forget the run once the frontend has acknowledged completion — keeps the
// in-memory map from growing across long sessions.
//
// IMPORTANT: never drop the run while still `running`; a transient status-poll
// failure must not make the later /verdict or /done callback look untracked.
export function forgetQaRun(id: string): void {
  registry.forget(id);
}
