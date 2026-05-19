import type { PushRun } from './types.js';

export type PushRunEvent =
  | { type: 'recorded'; run: PushRun }
  | { type: 'done'; run: PushRun }
  | { type: 'forgotten'; id: string; projectPath: string };

type PushRunListener = (event: PushRunEvent) => void;

const runs = new Map<string, PushRun>();
const listeners = new Set<PushRunListener>();

function notify(event: PushRunEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.error('[pushRuns] listener threw:', err);
    }
  }
}

export function getPushRun(id: string): PushRun | undefined {
  return runs.get(id);
}

export function recordPushRun(run: PushRun): void {
  runs.set(run.id, run);
  notify({ type: 'recorded', run: { ...run } });
}

export function markPushRunDone(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.status === 'done') return false;
  r.status = 'done';
  r.doneAt = Date.now();
  notify({ type: 'done', run: { ...r } });
  return true;
}

// Forget the run after the frontend has acknowledged completion. Keeps the
// in-memory map from growing across long sessions.
export function forgetPushRun(id: string): void {
  const existing = runs.get(id);
  if (!runs.delete(id)) return;
  notify({ type: 'forgotten', id, projectPath: existing?.projectPath ?? '' });
}

// Subscribe to push-run lifecycle events. Used by the workflow Push control
// step to await the 'done' event without polling.
export function subscribePushRuns(fn: PushRunListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
