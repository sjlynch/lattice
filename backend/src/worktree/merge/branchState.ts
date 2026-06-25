import {
  branchCommitCount,
  branchIsAncestorOfHead,
} from '../state.js';
import type { MergeOutcome } from '../merge.js';

export type BranchStateCheck =
  | { kind: 'empty' }
  | { kind: 'already-merged' }
  | { kind: 'ahead'; commits: number }
  | { kind: 'error'; outcome: MergeOutcome };

export async function checkBranchState(
  repoRoot: string,
  branchName: string,
): Promise<BranchStateCheck> {
  let commits: number;
  try {
    commits = await branchCommitCount(repoRoot, branchName);
  } catch (err) {
    // A git error counting commits is NOT a genuine zero — don't let a
    // transient failure be misread as an empty / already-merged branch (which
    // would silently drop the merge). Surface it as an error outcome so the
    // caller reports it and the merge can be re-attempted.
    return {
      kind: 'error',
      outcome: {
        status: 'error',
        message:
          `Could not count commits on "${branchName}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (commits === 0) {
    const isAncestor = await branchIsAncestorOfHead(repoRoot, branchName);
    if (isAncestor) {
      // All branch commits are already in main — it was previously merged
      // (including the case where main was fast-forwarded exactly to the
      // branch tip, making `behind` = 0). Caller should run cleanup.
      return { kind: 'already-merged' };
    }
    return { kind: 'empty' };
  }

  return { kind: 'ahead', commits };
}

export function emptyBranchOutcome(branchName: string): MergeOutcome {
  return {
    status: 'error',
    message:
      `Branch "${branchName}" was not found or is not reachable from HEAD ` +
      `and has no commits ahead. Inspect with \`git branch -a\` and ` +
      `\`git log ${branchName}\`.`,
  };
}
