import type { GitCommit, GitCommitChange, GitFileStatus } from './types.js';

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

export function gitLogFormat(): string {
  return `${COMMIT_HEAD}%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%at${FIELD_SEP}%s`;
}

export function parseGitLogNameStatus(out: string): GitCommit[] {
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
