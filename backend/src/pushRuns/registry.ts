import {
  createOneOffRunRegistry,
  type OneOffRunRegistryEvent,
  type OneOffRunRegistryListener,
} from '../homeScratch/registry.js';
import type { PushRun } from './types.js';

export type PushRunEvent = OneOffRunRegistryEvent<PushRun>;
type PushRunListener = OneOffRunRegistryListener<PushRun>;

const registry = createOneOffRunRegistry<PushRun>({
  logLabel: '[pushRuns]',
  emitEvents: true,
});

export function getPushRun(id: string): PushRun | undefined {
  return registry.get(id);
}

export function recordPushRun(run: PushRun): void {
  registry.record(run);
}

export function markPushRunDone(id: string): boolean {
  return registry.markDone(id);
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
  registry.forget(id);
}

// Subscribe to push-run lifecycle events. Used by the workflow Push control
// step to await the 'done' event without polling.
export function subscribePushRuns(fn: PushRunListener): () => void {
  return registry.subscribe(fn);
}
