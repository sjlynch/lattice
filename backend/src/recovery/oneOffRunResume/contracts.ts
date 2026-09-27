import type { forEachKnownProjectSafely } from '../projectIteration.js';

// A pty found gone is settled only after this long, giving the callback outbox
// time to replay a completion the agent sent while the backend was down.
export const LOST_SETTLE_GRACE_MS = 90_000;
// How often the liveness watch re-probes the re-adopted runs' ptys.
export const ONE_OFF_WATCH_INTERVAL_MS = 30_000;
// A re-adopted post-merge hook gets at least this long to call back, even when
// it had already used up the merge's 30-minute budget before the restart.
export const READOPTED_HOOK_MIN_WAIT_MS = 5 * 60 * 1000;

export type OneOffRunKind = 'push' | 'qa' | 'post-merge-hook';

export type AnyRun = { id: string; projectPath: string; cwd: string };

export type Adapter<Run extends AnyRun> = {
  kind: OneOffRunKind;
  noun: string;
  load(projectPath: string): Promise<Run[]>;
  // `alive: false` = the pty is already known gone (settled after the grace).
  restore(run: Run, alive: boolean): boolean;
  isRunning(id: string): boolean;
  // Presence / quiescence / wait bookkeeping for a session believed alive.
  onReadopted(run: Run): void;
  // Settle a run whose pty is gone, and reclaim its scratch dir (usually a
  // no-op: the boot sweep already took a dir whose pty died before boot).
  settleLost(run: Run, reason: string): Promise<void>;
};

// Keep each run paired with its typed callbacks before it enters the shared watch.
export type Watched = {
  kind: OneOffRunKind;
  noun: string;
  run: AnyRun;
  isRunning(): boolean;
  settleLost(reason: string): Promise<void>;
  // When the pty was first seen gone (cleared if it is seen again).
  goneSince?: number;
  reason: string;
};

export type OneOffResumeDeps = {
  listSessions?: () => Promise<unknown[] | null>;
  forEachProject?: typeof forEachKnownProjectSafely;
  now?: () => number;
  // Tests drive the watch by hand.
  startWatch?: boolean;
};
