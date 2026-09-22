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

// `git log` C-quotes a path even under core.quotePath=false when it holds a
// double quote, a backslash, or a control character (tab, newline, …):
// `"a\tb.ts"`. Only possible on POSIX filesystems, but there the quoted
// spelling never matched the graph's file id, so the change ring silently
// vanished. Undo the quoting: C escapes plus octal byte escapes, decoded as
// UTF-8. Anything not wrapped in quotes is returned untouched.
const C_ESCAPES: Record<string, number> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
};

export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\' || i + 1 >= body.length) {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += 3;
    } else if (Object.hasOwn(C_ESCAPES, next)) {
      bytes.push(C_ESCAPES[next]);
      i += 1;
    } else {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseNameStatusToken(token: string): ParsedNameStatus | null {
  // git log --name-status emits codes like A, M, D, R100, C75. We only
  // care about the leading letter; renames/copies also include a score we
  // can ignore.
  const ch = token[0];
  if (ch === 'A' || ch === 'M' || ch === 'D') {
    return { status: ch, hasPathPair: false };
  }
  // A type change (regular file <-> symlink / submodule) keeps the path: to the
  // change rings it is a modification. Dropping it lost the commit's ring.
  if (ch === 'T') {
    return { status: 'M', hasPathPair: false };
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
