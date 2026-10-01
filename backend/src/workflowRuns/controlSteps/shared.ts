// Shared helpers for the control-step workers (start / merge / push).
//
// `emitControlProgress` is the single place that shapes the
// `step-control-progress` WS payload so every worker reports progress the
// same way. `subscribeOnce` / `isRunEndedEvent` are the small subscription
// primitives the waits share. The three waits live in their own files and
// are re-exported here: `waitForLaneEmpty` (laneWait.ts) drains the push
// step's lane; `waitForMergeWork` (mergeWorkWait.ts) watches admitted runs and
// ready work; `waitForPostMergeHookIdle` (postMergeHookWait.ts) is the
// post-merge hook gate.

import type { WorkflowStepKind } from '../../workflows.js';
import { notify, type WorkflowRun } from '../state.js';

export { isRunEndedEvent } from './waitPrimitives.js';
export { waitForLaneEmpty, type LaneWaitDeps } from './laneWait.js';
export { waitForMergeWork, type MergeWorkWaitDeps } from './mergeWorkWait.js';
export {
  waitForPostMergeHookIdle,
  type PostMergeHookWaitDeps,
} from './postMergeHookWait.js';

// Subscribe-before-check wait that settles exactly once. `install` subscribes
// a listener that calls `settle` and returns its unsubscribe; the returned
// function is that same `settle`, for the caller's own checks. Settling
// unsubscribes, then calls `onSettle` — even when the listener fires
// synchronously inside `install`, before its unsubscribe exists (it is then
// called right after assignment).
export function subscribeOnce(
  install: (settle: () => void) => () => void,
  onSettle: () => void,
): () => void {
  let settled = false;
  let unsub: (() => void) | null = null;
  let unsubscribeAfterAssign = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (unsub) unsub();
    else unsubscribeAfterAssign = true;
    onSettle();
  };
  unsub = install(settle);
  if (unsubscribeAfterAssign) unsub();
  return settle;
}

export function emitControlProgress(
  run: WorkflowRun,
  stepIndex: number,
  kind: WorkflowStepKind,
  current: number,
  total: number,
  message?: string,
): void {
  notify({
    type: 'step-control-progress',
    ...((run.activeStepIndices?.length ?? 0) > 1 ? { parallel: true } : {}),
    runId: run.id,
    projectPath: run.projectPath,
    stepIndex,
    kind,
    current,
    total,
    message,
  });
}
