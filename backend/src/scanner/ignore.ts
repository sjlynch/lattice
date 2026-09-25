import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { IGNORE_DIR_NAMES } from '../health/constants.js';

export async function loadGitignore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(Array.from(IGNORE_DIR_NAMES));
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(content);
  } catch {
    // no .gitignore — fine
  }
  // The repo-local, untracked `info/exclude` too, as git itself does. It is
  // where Lattice records its own managed files (the root `.pi/extensions`
  // shims, `.claude/settings.local.json`, … — worktree/managedFiles.ts):
  // writing them into the TRACKED `.gitignore` dirtied the user's main
  // checkout (and, on Lattice's own repo, every managed-file addition landed
  // as an uncommitted `.gitignore` edit on main).
  const exclude = await readInfoExclude(root);
  if (exclude) ig.add(exclude);
  return ig;
}

// `<gitdir>/info/exclude` for a repo rooted at `root`, via the COMMON gitdir
// (git reads `info/exclude` only from there): `.git` is a directory in a main
// checkout, or a `gitdir: <path>` pointer file in a linked worktree whose
// `commondir` names the shared one. Null when there is none / it's unreadable.
async function readInfoExclude(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git');
  let gitDir = dotGit;
  try {
    const st = await fs.stat(dotGit);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(root, m[1].trim());
      const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
      if (common) gitDir = path.resolve(gitDir, common.trim());
    }
    return await fs.readFile(path.join(gitDir, 'info', 'exclude'), 'utf8');
  } catch {
    return null;
  }
}
