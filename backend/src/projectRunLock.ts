// Cross-process exclusion for repo-mutating runs (merge-all, manual
// /merge). The in-process guards in mergeRuns.ts and mergeLocks.ts only
// prevent races within a single Lattice process — but Lattice can be
// running on the same project in two places at once (the prototypical
// case: Lattice opened on its own repo, while another Lattice instance
// has the same repo as a project). Both processes can otherwise enter
// the merge pipeline concurrently and race on `git status` / snapshot /
// FF, with destructive results.
//
// Mechanism: a lockfile at `~/.lattice/per-project/<hash>/run.lock`
// holding `{pid, hostname, startedAt, label}`. Created with `wx` (atomic
// fail-if-exists). On contention we read the existing file and, if the
// owner PID is alive, refuse. If the owner is dead (server crashed mid-
// run), we steal the lock — same behaviour as snapshot recovery: assume
// a previous run died and the next one should proceed.

export {
  ProjectRunLockedError,
  RUN_TESTS_LOCK_LABEL_PREFIX,
  REPO_MAINTENANCE_LOCK_LABEL,
  REPO_MAINTENANCE_BUSY_MESSAGE,
  RepoMaintenanceBusyError,
  isLocalRepoMaintenanceHold,
  describeProjectRunLockHolder,
} from './projectRunLock/errors.js';
export { inspectProjectRunLock } from './projectRunLock/inspect.js';
export { acquireProjectRunLock } from './projectRunLock/acquire.js';
export { withProjectRunLock } from './projectRunLock/withLock.js';
export {
  withProjectMutation,
  waitForExclusiveProjectHold,
  localExclusiveProjectHold,
} from './projectRunLock/mutation.js';
export type { ProjectRunLockHandle } from './projectRunLock/types.js';
