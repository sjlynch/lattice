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
//
// IMPORTANT: never drop a run that is still `running`. The frontend status
// poller calls this (via DELETE /api/push-runs/:id) whenever it sees the run
// finished — and a *transient* `GET /api/push-runs/:id` hiccup is
// indistinguishable from "the run is gone". Honoring that for a live run would
// delete it from the registry before its Stop hook posts `/done`, so the later
// `markPushRunDone` finds no run (returns false, emits no 'done' event) and any
// 'done'-event waiter (the workflow Push control step) hangs. A live run is
// only ever forgotten after its Stop hook has marked it `done`; an unknown id
// is a harmless no-op. Mirrors forgetQaRun.
export function forgetPushRun(id: string): void {
  const existing = runs.get(id);
  if (existing && existing.status !== 'done') return;
  if (!runs.delete(id)) return;
  notify({ type: 'forgotten', id, projectPath: existing?.projectPath ?? '' });
}

// Subscribe to push-run lifecycle events. Used by the workflow Push control
// step to await the 'done' event without polling.
export function subscribePushRuns(fn: PushRunListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
