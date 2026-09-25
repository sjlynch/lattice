// Outcome types shared by the merge pipeline: `../merge.ts` (in-worktree
// merge), `fastForward.ts` (fast-forward main) and the per-step helpers.
// Re-exported from `../merge.ts`, whose import path callers keep using.

export type MergeConflictKind = 'merge' | 'stash-pop';

export type MergeOutcome =
  | { status: 'clean'; snapshotWarning?: string }
  | {
      status: 'conflict';
      conflictKind: MergeConflictKind;
      conflictedFiles: string[];
      stashRef?: string;
    }
  | { status: 'error'; message: string };
