import {
  GIT_LOG_COMMIT_HEADER,
  GIT_LOG_FIELD_SEPARATOR,
  normalizeGitPath,
  parseNameStatusToken,
} from './parserShared.js';
import type { GitCommit, GitCommitChange } from './types.js';

export function gitLogFormat(): string {
  return [
    `${GIT_LOG_COMMIT_HEADER}%H`,
    '%h',
    '%an',
    '%at',
    '%s',
  ].join(GIT_LOG_FIELD_SEPARATOR);
}

export function parseGitLogNameStatus(out: string): GitCommit[] {
  const blocks = out.split(GIT_LOG_COMMIT_HEADER).slice(1); // drop preamble before first marker
  const commits: GitCommit[] = [];
  for (const block of blocks) {
    // First newline ends the format line; everything after is the
    // name-status block (until the next sentinel, which split already
    // consumed).
    const nlIdx = block.indexOf('\n');
    const headerLine = nlIdx === -1 ? block : block.slice(0, nlIdx);
    const body = nlIdx === -1 ? '' : block.slice(nlIdx + 1);
    const parts = headerLine.split(GIT_LOG_FIELD_SEPARATOR);
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
      const parsed = parseNameStatusToken(cols[0]);
      if (!parsed) continue;
      if (parsed.hasPathPair && cols.length >= 3) {
        const oldPath = normalizeGitPath(cols[1]);
        const newPath = normalizeGitPath(cols[2]);
        // Surface a rename as one delete + one add so the frontend can
        // ring both (deleted ghost + green-ringed new node).
        changes.push({ path: oldPath, status: 'D' });
        changes.push({ path: newPath, status: 'A', oldPath });
      } else {
        changes.push({ path: normalizeGitPath(cols[1]), status: parsed.status });
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
