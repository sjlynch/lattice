import type { PushRun } from './types.js';

const runs = new Map<string, PushRun>();

export function getPushRun(id: string): PushRun | undefined {
  return runs.get(id);
}

export function recordPushRun(run: PushRun): void {
  runs.set(run.id, run);
}

export function markPushRunDone(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status === 'done') return false;
  r.status = 'done';
  r.doneAt = Date.now();
  return true;
}

// Forget the run after the frontend has acknowledged completion. Keeps the
// in-memory map from growing across long sessions.
export function forgetPushRun(id: string): void {
  runs.delete(id);
}
