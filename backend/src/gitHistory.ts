// Git-history endpoint backing the timeline scrubber. We shell out to
// `git log` once per request with `--name-status` so the frontend gets
// commits and their changed-file lists in a single round trip; the
// scrubber can then derive the per-range change map purely client-side
// without re-hitting the backend on every drag.

import path from 'node:path';
import { exec } from './worktree/exec.js';

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
};

// Sentinel used between fields inside a single commit's --format line.
// Picked to be exotic enough that real subjects won't contain it.
const FIELD_SEP = '␟';
// Sentinel used between commits. `git log -z` switches the inter-record
// separator to NUL, but we still need to find where the commit metadata
// line ends and the name-status block begins for that commit. We use a
// custom record header marker that's unique enough to split on safely.
const COMMIT_HEAD = '␃COMMIT␃';

function parseStatus(token: string): { status: GitFileStatus; isRename: boolean } | null {
  // git log --name-status emits codes like A, M, D, R100, C75. We only
  // care about the leading letter; renames also include the score we
  // can ignore.
  const ch = token[0];
  if (ch === 'A' || ch === 'M' || ch === 'D') {
    return { status: ch, isRename: false };
  }
  if (ch === 'R' || ch === 'C') {
    // Treat copies the same as renames (old + new paths).
    return { status: 'R', isRename: true };
  }
  return null;
}

function toForwardSlashes(p: string): string {
  return p.split('\\').join('/');
}

async function isGitRepo(repoRoot: string): Promise<boolean> {
  const r = await exec('git', ['rev-parse', '--is-inside-work-tree'], repoRoot, {
    timeoutMs: 4000,
  });
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function readCommits(repoRoot: string, limit: number): Promise<GitCommit[]> {
  // `--format` emits one header line per commit (with our sentinels),
  // followed by the name-status block, terminated with a blank line.
  // Using NUL between fields *within* the name-status output (`-z`)
  // would interleave with our own sentinels in a fragile way; staying
  // line-oriented and parsing with split is simpler and plenty fast for
  // ~10 commits.
  const fmt =
    `${COMMIT_HEAD}%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%at${FIELD_SEP}%s`;
  const r = await exec(
    'git',
    [
      'log',
      `-${Math.max(1, Math.min(50, Math.floor(limit)))}`,
      '--no-merges',
      '--name-status',
      // -M turns on rename detection so renamed files surface as `R…`
      // entries (which we decompose into delete + add); without it git
      // emits add/delete pairs instead, which is fine — we just lose the
      // oldPath linkage. `--no-renames=false` is invalid syntax.
      '-M',
      `--format=${fmt}`,
    ],
    repoRoot,
    { timeoutMs: 6000 },
  );
  if (r.code !== 0) {
    // No commits yet, shallow repo with no history, etc. — return empty.
    return [];
  }

  const out = r.stdout;
  const blocks = out.split(COMMIT_HEAD).slice(1); // drop preamble before first marker
  const commits: GitCommit[] = [];
  for (const block of blocks) {
    // First newline ends the format line; everything after is the
    // name-status block (until the next sentinel, which split already
    // consumed).
    const nlIdx = block.indexOf('\n');
    const headerLine = nlIdx === -1 ? block : block.slice(0, nlIdx);
    const body = nlIdx === -1 ? '' : block.slice(nlIdx + 1);
    const parts = headerLine.split(FIELD_SEP);
    if (parts.length < 5) continue;
    const [sha, shortSha, authorName, atSec, subject] = parts;
    const dateMs = Number(atSec) * 1000;

    const changes: GitCommitChange[] = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      // Lines look like:
      //   M\tpath/to/file
      //   A\tpath/to/new
      //   D\tpath/to/old
      //   R100\tpath/from\tpath/to
      const cols = line.split('\t');
      if (cols.length < 2) continue;
      const parsed = parseStatus(cols[0]);
      if (!parsed) continue;
      if (parsed.isRename && cols.length >= 3) {
        const oldPath = toForwardSlashes(cols[1]);
        const newPath = toForwardSlashes(cols[2]);
        // Surface a rename as one delete + one add so the frontend can
        // ring both (deleted ghost + green-ringed new node).
        changes.push({ path: oldPath, status: 'D' });
        changes.push({ path: newPath, status: 'A', oldPath });
      } else {
        changes.push({ path: toForwardSlashes(cols[1]), status: parsed.status });
      }
    }
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      authorName: authorName ?? '',
      date: dateMs,
      changes,
    });
  }
  // git log emits newest-first; the scrubber wants oldest→newest.
  commits.reverse();
  return commits;
}

async function readUncommitted(repoRoot: string): Promise<GitUncommitted> {
  // `git status --porcelain=v1 -z` gives a NUL-separated stream of
  // `XY path` records (rename targets are followed by a second NUL +
  // old path). We don't need staged/unstaged distinction for the
  // change rings — we just care that a path is dirty. Index + worktree
  // codes are merged into a single status per path, picking the most
  // visible state (D > A > M).
  const r = await exec('git', ['status', '--porcelain=v1', '-z'], repoRoot, {
    timeoutMs: 4000,
  });
  if (r.code !== 0) return { changes: [] };

  const tokens = r.stdout.split('\0');
  const byPath = new Map<string, GitFileStatus>();
  function bump(p: string, s: GitFileStatus) {
    const cur = byPath.get(p);
    // Priority: D > A > M (more "structural" change wins).
    const rank = (x: GitFileStatus) => (x === 'D' ? 3 : x === 'A' ? 2 : x === 'R' ? 2 : 1);
    if (!cur || rank(s) > rank(cur)) byPath.set(p, s);
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.length < 3) continue;
    const xy = t.slice(0, 2);
    const filePath = t.slice(3); // skip "XY "
    const x = xy[0];
    const y = xy[1];
    // Renames: porcelain emits `R  newPath\0oldPath`. Consume the next
    // token as the previous path.
    if (x === 'R' || y === 'R') {
      const oldPath = tokens[i + 1] ?? '';
      i += 1;
      if (oldPath) bump(toForwardSlashes(oldPath), 'D');
      bump(toForwardSlashes(filePath), 'A');
      continue;
    }
    if (x === '?' || y === '?') {
      bump(toForwardSlashes(filePath), 'A');
      continue;
    }
    if (x === 'D' || y === 'D') {
      bump(toForwardSlashes(filePath), 'D');
      continue;
    }
    if (x === 'A' || y === 'A') {
      bump(toForwardSlashes(filePath), 'A');
      continue;
    }
    bump(toForwardSlashes(filePath), 'M');
  }

  const changes: GitCommitChange[] = [];
  for (const [p, s] of byPath) changes.push({ path: p, status: s });
  return { changes };
}

export async function getGitHistory(
  repoRoot: string,
  limit: number,
): Promise<GitHistoryResult> {
  const abs = path.resolve(repoRoot);
  if (!(await isGitRepo(abs))) {
    return { isRepo: false, commits: [], uncommitted: { changes: [] } };
  }
  // Fetch in parallel — they're independent git invocations.
  const [commits, uncommitted] = await Promise.all([
    readCommits(abs, limit),
    readUncommitted(abs),
  ]);
  return { isRepo: true, commits, uncommitted };
}
