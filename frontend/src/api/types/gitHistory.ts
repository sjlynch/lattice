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
  // Compact fingerprint of the current repo state (HEAD + dirty set). Used to
  // dedupe the /ws/git-status live-refresh against the value last fetched here.
  // Empty string when the folder isn't a git repo.
  signature: string;
};
