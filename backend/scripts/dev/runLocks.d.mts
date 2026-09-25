// Hand-written declarations for the JS dev-runner run.lock scan, so TS
// consumers (the __tests__ suite, via restartPolicy.d.mts) get types for it.
// Keep in sync with runLocks.mjs.

export const PER_PROJECT_DIR: string;
export const PROCESS_START_FUZZ_MS: number;

export interface RunLockScanOptions {
  perProjectDir?: string;
  isPidAlive?: (pid: number) => boolean;
  hostname?: string;
  // OS-reported start time (epoch ms) of a live PID, or null when unknown.
  readProcessStartTime?: (pid: number) => number | null;
  // One probe per distinct `(pid, startedAt, ownerId)` lock body.
  startTimeCache?: Map<string, number | null>;
}

// A live run.lock: which per-project hash holds it, the op label, the holder
// PID and when the lock was written (0 when the body carried no startedAt).
export interface RunLock {
  hash: string;
  label: string;
  pid: number;
  startedAt: number;
}

export function pidAlive(pid: number): boolean;
export function processStartTimeMs(pid: number): number | null;
export function isWorkflowLockLabel(label: unknown): boolean;
export function heldRunLocks(opts?: RunLockScanOptions): RunLock[];
export function heldRunLockLabels(opts?: RunLockScanOptions): string[];
export function describeRunLocks(locks: RunLock[] | null | undefined): string;
export function repoOperationInFlight(opts?: RunLockScanOptions): boolean;
export function workflowRunInFlight(opts?: RunLockScanOptions): boolean;

// GET /api/internal/restart-drain/lock-holders, as restartHandshake.mjs returns it.
export type LockHoldersReport =
  | { ok: true; pid: number; holders: Array<{ hash: string; parkedOn: string | null; detail?: string }> }
  | { ok: false; why: string };

export function locksParkedOnLiveAgents(
  locks: RunLock[],
  report: LockHoldersReport | null | undefined,
): boolean;
export function parkedDetail(locks: RunLock[], report: LockHoldersReport | null | undefined): string;
