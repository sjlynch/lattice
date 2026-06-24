import fs from 'node:fs/promises';
import path from 'node:path';

// One bounded, breadth-overlapping directory walker shared by the health
// analyzers' file finders (tsconfig discovery, package.json resolution). It
// replaces three near-identical hand-rolled walks: readdir withFileTypes in a
// try/catch, skip never-descend directories, fan out the subdir walks and
// await them together. Each caller supplies its own match predicate via
// `onFile`, its depth cap, and the skip-dir set (the canonical
// `IGNORE_DIR_NAMES`), so there's one source of truth for "what the analyzers
// walk".
//
// Directories whose name is in `skipDirs` are never descended into; every
// other directory (including dotfile dirs like `.github`/`.config` that aren't
// in the skip set) is recursed. `onFile` is invoked for every non-directory
// entry, with the absolute path and the entry name, so the caller can apply
// its own filename predicate. Read errors on a directory are swallowed (that
// subtree is simply skipped) — discovery is best-effort.
export type WalkSourceTreeOptions = {
  // Inclusive depth cap; the root is depth 0. A subtree deeper than this is
  // not visited.
  maxDepth: number;
  // Directory names to never descend into (vendor/generated caches, .git, …).
  skipDirs: ReadonlySet<string>;
  // Called for each file entry encountered (absolute path + entry name).
  onFile: (filePath: string, name: string) => void;
};

export async function walkSourceTree(
  root: string,
  { maxDepth, skipDirs, onFile }: WalkSourceTreeOptions,
): Promise<void> {
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subwalks: Promise<void>[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        subwalks.push(walk(path.join(dir, e.name), depth + 1));
      } else if (e.isFile()) {
        onFile(path.join(dir, e.name), e.name);
      }
    }
    await Promise.all(subwalks);
  }
  await walk(root, 0);
}
