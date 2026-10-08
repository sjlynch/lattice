import { canonicalProjectPath } from '../projectPath.js';
import { createEmitter } from '../emitter.js';

// A trigger must read settings before it can construct the full run record.
// Keep that pre-record launch window visible to the workflow Merge-step gate;
// otherwise Phase C can observe "idle" while a hook is already starting.
// Re-exported from `./registry.ts`, the import path callers use.
const pendingTriggerCounts = new Map<string, number>();
type TriggerListener = (projectPath: string) => void;
const triggers = createEmitter<[string]>('post-merge-hook-trigger');

function notifyTriggerListeners(key: string): void {
  triggers.emit(key);
}

export function beginPostMergeHookTrigger(projectPath: string): () => void {
  const key = canonicalProjectPath(projectPath);
  pendingTriggerCounts.set(key, (pendingTriggerCounts.get(key) ?? 0) + 1);
  notifyTriggerListeners(key);

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (pendingTriggerCounts.get(key) ?? 1) - 1;
    if (remaining > 0) pendingTriggerCounts.set(key, remaining);
    else pendingTriggerCounts.delete(key);
    notifyTriggerListeners(key);
  };
}

export function hasPendingPostMergeHookTrigger(projectPath: string): boolean {
  return (pendingTriggerCounts.get(canonicalProjectPath(projectPath)) ?? 0) > 0;
}

export function subscribePostMergeHookTriggers(fn: TriggerListener): () => void {
  return triggers.subscribe(fn);
}
