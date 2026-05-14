# backend/src/recovery

Boot-time crash recovery for project/task state. `../recovery.ts` is only the stable public shim; keep implementation here.

## Boot order

1. `restoreAllProjectsFromBackup` — repair task DB files before any task cache read.
2. `recoverPendingSnapshots` — restore copy-based working-tree snapshots left by crashed merge/finalize work.
3. `sweepOrphanedWorktrees` (`worktreeSweep.ts`) — remove only Lattice-managed worktrees that no active task owns.
4. Branch repair (`index.ts`) — `ready_to_merge` tasks whose branch is gone are marked `qa` because finalize cleanup already ran.
5. `resumeInterruptedMergeRuns` (`mergeRunResume.ts`) — called after HTTP listen so spawned resolvers can call the API.

## Safety invariants

- Keep recovery best-effort: log a failed phase/project and continue booting.
- Project iteration must go through `forEachKnownProjectSafely` so one broken project cannot block others.
- Do not add raw recursive deletes here; worktree removal goes through `cleanupWorktreeForTask` / `git worktree remove`.
- Do not run stale merge-run resume before the server is listening.
