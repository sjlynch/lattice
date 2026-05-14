import type { GitCommitChange, GitFileStatus, GitUncommitted } from './types.js';

function toForwardSlashes(p: string): string {
  return p.split('\\').join('/');
}

function rankStatus(x: GitFileStatus): number {
  return x === 'D' ? 3 : x === 'A' ? 2 : x === 'R' ? 2 : 1;
}

function bumpStatus(byPath: Map<string, GitFileStatus>, p: string, s: GitFileStatus): void {
  const cur = byPath.get(p);
  // Priority: D > A > M (more "structural" change wins).
  if (!cur || rankStatus(s) > rankStatus(cur)) byPath.set(p, s);
}

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
    const filePath = t.slice(3); // skip "XY "
    const x = xy[0];
    const y = xy[1];
    // Renames: porcelain emits `R  newPath\0oldPath`. Consume the next
    // token as the previous path.
    if (x === 'R' || y === 'R') {
      const oldPath = tokens[i + 1] ?? '';
      i += 1;
      if (oldPath) bumpStatus(byPath, toForwardSlashes(oldPath), 'D');
      bumpStatus(byPath, toForwardSlashes(filePath), 'A');
      continue;
    }
    if (x === '?' || y === '?') {
      bumpStatus(byPath, toForwardSlashes(filePath), 'A');
      continue;
    }
    if (x === 'D' || y === 'D') {
      bumpStatus(byPath, toForwardSlashes(filePath), 'D');
      continue;
    }
    if (x === 'A' || y === 'A') {
      bumpStatus(byPath, toForwardSlashes(filePath), 'A');
      continue;
    }
    bumpStatus(byPath, toForwardSlashes(filePath), 'M');
  }

  const changes: GitCommitChange[] = [];
  for (const [p, s] of byPath) changes.push({ path: p, status: s });
  return { changes };
}
