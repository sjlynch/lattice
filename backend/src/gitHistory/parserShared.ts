import type { GitFileStatus } from './types.js';

// Sentinel used between fields inside a single commit's --format line.
// Picked to be exotic enough that real subjects won't contain it.
export const GIT_LOG_FIELD_SEPARATOR = '␟';

// Sentinel used between commits. `git log -z` switches the inter-record
// separator to NUL, but we still need to find where the commit metadata
// line ends and the name-status block begins for that commit. We use a
// custom record header marker that's unique enough to split on safely.
export const GIT_LOG_COMMIT_HEADER = '␃COMMIT␃';

const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  M: 1,
  A: 2,
  R: 2,
  D: 3,
};

export type ParsedNameStatus = {
  status: GitFileStatus;
  hasPathPair: boolean;
};

export function normalizeGitPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

export function parseNameStatusToken(token: string): ParsedNameStatus | null {
  // git log --name-status emits codes like A, M, D, R100, C75. We only
  // care about the leading letter; renames/copies also include a score we
  // can ignore.
  const ch = token[0];
  if (ch === 'A' || ch === 'M' || ch === 'D') {
    return { status: ch, hasPathPair: false };
  }
  if (ch === 'R' || ch === 'C') {
    // Treat copies the same as renames (old + new paths).
    return { status: 'R', hasPathPair: true };
  }
  return null;
}

export function statusPriority(status: GitFileStatus): number {
  return STATUS_PRIORITY[status];
}

export function applyHigherPriorityStatus(
  byPath: Map<string, GitFileStatus>,
  filePath: string,
  status: GitFileStatus,
): void {
  const cur = byPath.get(filePath);
  // Priority: D > A/R > M (more "structural" change wins).
  if (!cur || statusPriority(status) > statusPriority(cur)) {
    byPath.set(filePath, status);
  }
}
