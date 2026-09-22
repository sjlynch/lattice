import { applyHigherPriorityStatus, normalizeGitPath } from './parserShared.js';
import type { GitCommitChange, GitFileStatus, GitUncommitted } from './types.js';

export function parseGitStatusPorcelain(out: string): GitUncommitted {
  // `git status --porcelain=v1 -z` gives a NUL-separated stream of
  // `XY path` records (rename targets are followed by a second NUL +
  // old path). We don't need staged/unstaged distinction for the
  // change rings — we just care that a path is dirty. Index + worktree
  // codes are merged into a single status per path, picking the most
  // visible state (D > A > M).
  const tokens = out.split('\0');
  const byPath = new Map<string, GitFileStatus>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.length < 3) continue;
    const xy = t.slice(0, 2);
    const filePath = normalizeGitPath(t.slice(3)); // skip "XY "
    const x = xy[0];
    const y = xy[1];
    // Renames and copies: porcelain emits `R  newPath\0oldPath` (and, with
    // `status.renames=copies`, `C  newPath\0oldPath`). Consume the next token
    // as the previous path so it is not parsed as a record of its own.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      const oldPath = tokens[i + 1] ?? '';
      i += 1;
      // Only a rename removes the source; a copy's source still exists.
      if (oldPath && (x === 'R' || y === 'R')) {
        applyHigherPriorityStatus(byPath, normalizeGitPath(oldPath), 'D');
      }
      applyHigherPriorityStatus(byPath, filePath, 'A');
      continue;
    }
    if (x === '?' || y === '?') {
      applyHigherPriorityStatus(byPath, filePath, 'A');
      continue;
    }
    if (x === 'D' || y === 'D') {
      applyHigherPriorityStatus(byPath, filePath, 'D');
      continue;
    }
    if (x === 'A' || y === 'A') {
      applyHigherPriorityStatus(byPath, filePath, 'A');
      continue;
    }
    applyHigherPriorityStatus(byPath, filePath, 'M');
  }

  const changes: GitCommitChange[] = [];
  for (const [p, s] of byPath) changes.push({ path: p, status: s });
  return { changes };
}
