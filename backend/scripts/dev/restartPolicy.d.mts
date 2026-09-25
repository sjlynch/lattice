// Hand-written declarations for the JS dev-runner restart policy, so TS
// consumers (the __tests__ suite) get types for its exported decision logic.
// Keep in sync with restartPolicy.mjs.

export const PER_PROJECT_DIR: string;
export const RESTART_DEBOUNCE_MS: number;
export const DEFERRED_RESTART_POLL_MS: number;
export const MAX_DEFER_MS: number;
export const HOLD_LOG_THROTTLE_MS: number;
export const PROCESS_START_FUZZ_MS: number;
export const WORKFLOW_DEFER_RELOG_MS: number;
export const LOCK_SETTLE_MS: number;
export const PARKED_PROBE_TTL_MS: number;
export const PARKED_HOLD_RELOG_MS: number;
export const IGNORED_EVENT_LOG_THROTTLE_MS: number;

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

export type DeferAction =
  | 'idle'
  | 'settle'
  | 'apply'
  | 'hold-workflow'
  | 'hold-parked'
  | 'force'
  | 'hold';

export function classifyDeferAction(args: {
  deferredSince: number;
  now: number;
  operationInFlight: boolean;
  workflowInFlight: boolean;
  maxDeferMs?: number;
  // Last time a scan saw any live run.lock (0 = never) and how long to wait
  // after the last one cleared before applying. Omitted → apply at once.
  lastLockSeenAt?: number;
  settleMs?: number;
  // The backend reports every held lock parked on a live agent.
  parkedOnLiveAgent?: boolean;
}): DeferAction;

// GET /api/internal/restart-drain/lock-holders, as restartHandshake.mjs returns it.
export type LockHoldersReport =
  | { ok: true; pid: number; holders: Array<{ hash: string; parkedOn: string | null; detail?: string }> }
  | { ok: false; why: string };

export function locksParkedOnLiveAgents(
  locks: RunLock[],
  report: LockHoldersReport | null | undefined,
): boolean;

export function createRestartPolicy(args?: {
  restartBackend: (reason: string) => boolean;
  // The single lock scan every defer/force/hold decision derives from.
  readHeldRunLocks?: () => RunLock[];
  // Legacy boolean probes; adapted into synthetic records when
  // `readHeldRunLocks` is not given.
  operationInFlight?: () => boolean;
  workflowInFlight?: () => boolean;
  // Newest mtime under dist/, or null when it can't be read (→ fail open).
  readNewestDistMtime?: () => number | null;
  readDistContentSignature?: () => string | null;
  canRestart?: () => boolean;
  needsBackendStart?: () => boolean;
  deferBaselineUntilSpawn?: boolean;
  now?: () => number;
  // Restart handshake (restartHandshake.mjs). Without prepareRestart a
  // restart is applied synchronously.
  prepareRestart?: (reason: string) => Promise<
    | { ok: true; ready: boolean; pending: string[]; waitedMs: number }
    | { ok: false; why: string }
  >;
  cancelRestartDrain?: (why: string) => Promise<unknown>;
  queryLockHolders?: () => Promise<LockHoldersReport>;
  // Wait this long after the last run.lock cleared before restarting.
  lockSettleMs?: number;
}): {
  // `force` skips the metadata-only check (a verified compile completion).
  onDistChanged(force?: boolean): void;
  scheduleDistChanged(eventType?: string | null, filename?: string | null): void;
  // Snapshot dist/'s current mtime as the "nothing new since here" mark.
  resetDistBaseline(): void;
  startDeferredPoll(): void;
  stopDeferredPoll(): void;
  onCompileSucceeded(): void;
  onBackendSpawned(candidate?: { mtime: number | null; content: string | null; compileSequence: number }): void;
  captureDistBaseline(): { mtime: number | null; content: string | null; compileSequence: number };
};
