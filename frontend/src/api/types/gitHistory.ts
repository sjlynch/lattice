export type GitFileStatus = 'A' | 'M' | 'D' | 'R';

export type GitCommitChange = {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
};

export type GitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  // Message body after the subject; optional so an older backend still types.
  body?: string;
  authorName: string;
  date: number;
  changes: GitCommitChange[];
};

export type GitUncommitted = {
  changes: GitCommitChange[];
};

export type GitHistoryResult = {
  isRepo: boolean;
  commits: GitCommit[];
  uncommitted: GitUncommitted;
  // History paths that no longer exist in the tree — computed by the backend
  // from `git ls-files` (see backend/src/gitHistory/deletedPaths.ts), because
  // neither the scan (extension-filtered) nor `git log` order (date-sorted
  // across branches) can answer it here. This IS the timeline's ghost-node set.
  deletedPaths: string[];
  // Compact fingerprint of the current repo state (HEAD + dirty set). Used to
  // dedupe the /ws/git-status live-refresh against the value last fetched here.
  // Empty string when the folder isn't a git repo.
  signature: string;
};
