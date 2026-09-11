import type { MergeRun } from './types.js';

const cancellations = new WeakMap<MergeRun, AbortController>();

export function mergeRunCancellation(run: MergeRun): AbortSignal {
  let controller = cancellations.get(run);
  if (!controller) { controller = new AbortController(); cancellations.set(run, controller); }
  if (run.cancelRequested) controller.abort(new Error('merge run cancelled'));
  return controller.signal;
}

export function cancelMergeRunSpawns(run: MergeRun): void {
  cancellations.get(run)?.abort(new Error('merge run cancelled'));
}
