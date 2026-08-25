export type GitFileStatus = 'A' | 'M' | 'D' | 'R';

export type GitCommitChange = {
  path: string;
  status: GitFileStatus;
  // For renames, the previous path (so the frontend can mark the old
  // path as removed and the new path as added if it cares).
  oldPath?: string;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: number; // ms since epoch
  changes: GitCommitChange[];
};

export type GitUncommitted = {
  changes: GitCommitChange[];
};

export type GitHistoryResult = {
  isRepo: boolean;
  // Oldest first, newest last — matches the left-to-right tick order on
  // the scrubber.
  commits: GitCommit[];
  uncommitted: GitUncommitted;
  // The subset of the paths mentioned above that no longer exist in the tree
  // (see gitHistory/deletedPaths.ts). This is the authoritative ghost-node set
  // for the timeline: the frontend cannot derive it, because the scan is
  // extension-filtered and `git log` order isn't a reliable stand-in for
  // "current state" once branches are involved. Sorted; empty when the folder
  // isn't a git repo or the tracked-file probe failed.
  deletedPaths: string[];
  // Compact fingerprint of the current repo state (HEAD + dirty set); see
  // gitHistory/signature.ts. The frontend uses it to dedupe the /ws/git-status
  // live-refresh (skip a re-fetch when the pushed signature matches the last
  // one it already fetched). Empty string when the folder isn't a git repo.
  signature: string;
};
