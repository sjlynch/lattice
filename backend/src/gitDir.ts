// Resolves a project folder's git metadata directory (walking up like git, and
// following a linked worktree's / submodule's `.git` gitdir-pointer file).

import { promises as fs } from 'node:fs';
import path from 'node:path';

// The target of a `.git` pointer FILE's `gitdir: <path>` line, as written (not
// resolved). Null when the text carries no such line.
export function parseGitdirPointer(text: string): string | null {
  const m = text.match(/^gitdir:\s*(.+)\s*$/m);
  return m ? m[1].trim() : null;
}

// Resolve the git metadata directory for a project folder. For a normal repo
// that's `<repo>/.git`; for a linked worktree / submodule `.git` is a FILE
// (`gitdir: <path>`, relative to the folder holding it) pointing at the real
// git dir, whose own HEAD/index/logs track that checkout. The search walks UP
// from the project folder the way git itself does, so a project opened on a
// subfolder of a repo (the `nested` probe state) still gets live branch and
// status updates — probing only `<project>/.git` left those with no watcher at
// all, while `getCurrentBranch` (plain git, which walks up) still showed the
// branch it could then never update. Returns null when no repo encloses it.
// Shared by gitBranch.ts and gitStatus.ts.
export async function resolveGitDir(projectRoot: string): Promise<string | null> {
  let dir = path.resolve(projectRoot);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let isDir: boolean | null = null;
    try {
      isDir = (await fs.stat(dotGit)).isDirectory();
    } catch {
      isDir = null;
    }
    if (isDir === true) return dotGit;
    if (isDir === false) {
      try {
        const raw = parseGitdirPointer(await fs.readFile(dotGit, 'utf8'));
        if (raw === null) return null;
        return path.isAbsolute(raw) ? raw : path.resolve(dir, raw);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
