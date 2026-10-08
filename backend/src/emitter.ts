// The one in-process pub/sub shape. Use it instead of a hand-rolled
// `new Set<Listener>()`:
//   - `subscribe` returns its own unsubscribe;
//   - `emit` iterates a SNAPSHOT, so a listener that (un)subscribes during an
//     emit affects the next emit, never this one;
//   - a throwing listener is logged (with `label`) and the rest still run;
//   - the subscriber count is a memory gauge (`listeners.<label>`), so a
//     subscription leak (a WS connection that never unsubscribed) shows up in
//     the `[mem]` line as a climbing count.

import { registerMemGauge } from './memDiag/gauges.js';

export type Emitter<A extends unknown[]> = {
  subscribe(fn: (...args: A) => void): () => void;
  emit(...args: A): void;
  // Drop every subscriber (test resets only).
  clear(): void;
  readonly size: number;
};

export function createEmitter<A extends unknown[]>(label: string): Emitter<A> {
  const listeners = new Set<(...args: A) => void>();
  registerMemGauge(`listeners.${label}`, () => listeners.size);
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit(...args) {
      for (const fn of [...listeners]) {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[${label}] listener threw:`, err);
        }
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}
