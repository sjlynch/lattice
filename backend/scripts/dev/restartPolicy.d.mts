// Hand-written declarations for the JS dev-runner restart policy, so TS
// consumers (the __tests__ suite) get types for its exported decision logic.
// Keep in sync with restartPolicy.mjs.

export const PER_PROJECT_DIR: string;
export const RESTART_DEBOUNCE_MS: number;
export const DEFERRED_RESTART_POLL_MS: number;
export const MAX_DEFER_MS: number;
export const WORKFLOW_DEFER_RELOG_MS: number;

export interface RunLockScanOptions {
  perProjectDir?: string;
  isPidAlive?: (pid: number) => boolean;
}

export function pidAlive(pid: number): boolean;
export function heldRunLockLabels(opts?: RunLockScanOptions): string[];
export function repoOperationInFlight(opts?: RunLockScanOptions): boolean;
export function workflowRunInFlight(opts?: RunLockScanOptions): boolean;

export type DeferAction = 'idle' | 'apply' | 'hold-workflow' | 'force' | 'hold';

export function classifyDeferAction(args: {
  deferredSince: number;
  now: number;
  operationInFlight: boolean;
  workflowInFlight: boolean;
  maxDeferMs?: number;
}): DeferAction;

export function createRestartPolicy(args?: {
  restartBackend: (reason: string) => boolean;
  operationInFlight?: () => boolean;
  workflowInFlight?: () => boolean;
}): {
  onDistChanged(): void;
  scheduleDistChanged(): void;
  startDeferredPoll(): void;
  stopDeferredPoll(): void;
};
