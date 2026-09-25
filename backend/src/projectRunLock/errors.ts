import type { LockBody } from './types.js';
import { isCurrentProcessHolder } from './liveness.js';

// The label prefix of the workflow Run tests step's hold (see
// workflowRuns/testStep/). Named here so the refusal message can say what is
// actually going on instead of "another process".
export const RUN_TESTS_LOCK_LABEL_PREFIX = 'workflow-test:';

// The label of the post-merge-run `git gc --auto` hold (worktree/repoMaintenance.ts).
export const REPO_MAINTENANCE_LOCK_LABEL = 'repo-maintenance';

export const REPO_MAINTENANCE_BUSY_MESSAGE =
  "Git housekeeping (git gc --auto) is running on this project's repository. Merging waits until it " +
  'finishes — a merge alongside a repack leaves a full copy of the packs behind on Windows. Try again in a few minutes.';

// startMergeRun's refusal while this process's post-run housekeeping is in
// flight (worktree/repoMaintenance.ts). Typed so callbacks that restart a run
// for the remaining Ready-to-Merge tasks (/stash-resolved, the resolver
// finalize) can tell "wait for the gc, then retry" apart from "another run is
// active and owns the rest" — see startMergeRunAfterMaintenance (mergeRuns.ts).
export class RepoMaintenanceBusyError extends Error {
  constructor(message: string = REPO_MAINTENANCE_BUSY_MESSAGE) {
    super(message);
    this.name = 'RepoMaintenanceBusyError';
  }
}

// True when `holder` is THIS process's housekeeping gc hold.
export function isLocalRepoMaintenanceHold(holder: LockBody): boolean {
  return holder.label === REPO_MAINTENANCE_LOCK_LABEL && isCurrentProcessHolder(holder);
}

export function describeProjectRunLockHolder(holder: LockBody): string {
  const since = new Date(holder.startedAt).toISOString();
  if (isCurrentProcessHolder(holder)) {
    if (holder.label.startsWith(RUN_TESTS_LOCK_LABEL_PREFIX)) {
      const runId = holder.label.slice(RUN_TESTS_LOCK_LABEL_PREFIX.length);
      return (
        `A workflow Run tests step (run ${runId}) is running the project's tests and ` +
        `committing fixes on its main checkout (since ${since}). Merging waits until that ` +
        `step finishes — try again then, or stop the workflow run.`
      );
    }
    if (holder.label === REPO_MAINTENANCE_LOCK_LABEL) return `${REPO_MAINTENANCE_BUSY_MESSAGE} (since ${since})`;
    return `Project run lock held by this Lattice backend (label=${holder.label}, started ${since}).`;
  }
  return (
    `Project run lock held by another process ` +
    `(pid=${holder.pid} on ${holder.hostname}, started ${since}, label=${holder.label}).`
  );
}

export class ProjectRunLockedError extends Error {
  readonly holder: LockBody;

  constructor(holder: LockBody) {
    super(describeProjectRunLockHolder(holder));
    this.name = 'ProjectRunLockedError';
    this.holder = holder;
  }
}
