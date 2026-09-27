// Leaf primitives the control-step waits share: the run-ended filter, the
// settle-once scaffolding and an unref'd re-armable timer. Kept free of any
// import from `shared.ts` (which re-exports the waits) so there is no cycle.

import type { WorkflowRunEvent } from '../state.js';

// True for the event that ends workflow run `runId` early — it was cancelled
// or errored. Every control-step wait resolves on it so the worker can exit
// (and release the project run-lock) promptly.
export function isRunEndedEvent(ev: WorkflowRunEvent, runId: string): boolean {
  if (!('run' in ev) || ev.run.id !== runId) return false;
  return ev.type === 'cancelled' || ev.type === 'errored';
}

export type WaitSettler<T> = {
  finish: (value: T) => void;
  fail: (err: unknown) => void;
  settled: () => boolean;
};

// Settle a wait's promise exactly once. Both paths run `cleanup` before
// resolving / rejecting; a non-Error rejection reason is wrapped in an Error.
export function createWaitSettler<T>(opts: {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}): WaitSettler<T> {
  let settled = false;
  return {
    finish: (value) => {
      if (settled) return;
      settled = true;
      opts.cleanup();
      opts.resolve(value);
    },
    fail: (err) => {
      if (settled) return;
      settled = true;
      opts.cleanup();
      opts.reject(err instanceof Error ? err : new Error(String(err)));
    },
    settled: () => settled,
  };
}

export type UnrefTimer = {
  // (Re)start the countdown from now, replacing any pending one.
  arm: () => void;
  clear: () => void;
};

// A re-armable `setTimeout(onFire, ms)` that alone never keeps the process
// alive. Re-arming on progress is what makes a wait's bound a no-progress one.
export function createUnrefTimer(ms: number, onFire: () => void): UnrefTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arm: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onFire, ms);
      timer.unref?.();
    },
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
