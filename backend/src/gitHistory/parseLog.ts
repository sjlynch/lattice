import {
  GIT_LOG_COMMIT_HEADER,
  GIT_LOG_FIELD_SEPARATOR,
  GIT_LOG_MESSAGE_END,
  normalizeGitPath,
  parseNameStatusToken,
  unquoteGitPath,
} from './parserShared.js';
import type { GitCommit, GitCommitChange } from './types.js';

// A name-status path column: C-quoting undone, separators normalized.
function logPath(col: string): string {
  return normalizeGitPath(unquoteGitPath(col));
}

export function gitLogFormat(): string {
  return [
    `${GIT_LOG_COMMIT_HEADER}%H`,
    '%h',
    '%an',
    '%at',
    '%s',
    `%b${GIT_LOG_MESSAGE_END}`,
  ].join(GIT_LOG_FIELD_SEPARATOR);
}

export function parseGitLogNameStatus(out: string): GitCommit[] {
  const blocks = out.split(GIT_LOG_COMMIT_HEADER).slice(1); // drop preamble before first marker
  const commits: GitCommit[] = [];
  for (const block of blocks) {
    // The message-end marker closes the multi-line format output (the body
    // spans lines); everything after it is the name-status block (until the
    // next sentinel, which split already consumed). Without the marker, the
    // first newline ends a body-less format line.
    const endIdx = block.indexOf(GIT_LOG_MESSAGE_END);
    const nlIdx = block.indexOf('\n');
    const headerEnd = endIdx !== -1 ? endIdx : nlIdx === -1 ? block.length : nlIdx;
    const bodyStart = endIdx !== -1 ? endIdx + GIT_LOG_MESSAGE_END.length : headerEnd + 1;
    const headerText = block.slice(0, headerEnd);
    const body = block.slice(bodyStart);
    const parts = headerText.split(GIT_LOG_FIELD_SEPARATOR);
    if (parts.length < 5) continue;
    const [sha, shortSha, authorName, atSec, subject, ...messageParts] = parts;
    const message = messageParts.join(GIT_LOG_FIELD_SEPARATOR).replace(/\r\n/g, '\n').trim();
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
        const oldPath = logPath(cols[1]);
        const newPath = logPath(cols[2]);
        // Surface a rename as one delete + one add so the frontend can
        // ring both (deleted ghost + green-ringed new node).
        changes.push({ path: oldPath, status: 'D' });
        changes.push({ path: newPath, status: 'A', oldPath });
      } else {
        changes.push({ path: logPath(cols[1]), status: parsed.status });
      }
    }
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      body: message,
      authorName: authorName ?? '',
      date: dateMs,
      changes,
    });
  }
  // git log emits newest-first; the scrubber wants oldest→newest.
  commits.reverse();
  return commits;
}
