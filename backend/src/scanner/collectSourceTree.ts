import fs from 'node:fs/promises';
import path from 'node:path';
import type { Ignore } from 'ignore';
import { SOURCE_EXTS } from '../health/constants.js';
import { canonicalProjectPath } from '../projectPath.js';

export type DirectoryEntry = {
  id: string;
  name: string;
  path: string;
  parentId: string;
};

export type CollectedSourceTree = {
  files: string[];
  directories: DirectoryEntry[];
};

export async function collectSourceTree(
  root: string,
  ignoreFilter: Pick<Ignore, 'ignores'>,
): Promise<CollectedSourceTree> {
  const absRoot = canonicalProjectPath(root);
  const files: string[] = [];
  const directories: DirectoryEntry[] = [];

  async function walk(dir: string, parentId: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Overlap sibling subtrees: collect each subdir walk and await them
    // together rather than serializing readdir round-trips. Mirrors the
    // proven pattern in findTsconfigs (health/tsconfig.ts) and
    // findPackageJsons (health/crossFile/roots.ts). Nothing downstream
    // depends on walk order — aggregate rebuilds dir nodes and sorts.
    const subwalks: Promise<void>[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(absRoot, abs).split(path.sep).join('/');
      if (!rel) continue;
      const testPath = entry.isDirectory() ? `${rel}/` : rel;
      if (ignoreFilter.ignores(testPath)) continue;

      if (entry.isDirectory()) {
        directories.push({ id: abs, name: entry.name, path: abs, parentId });
        subwalks.push(walk(abs, abs));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) files.push(abs);
      }
    }
    await Promise.all(subwalks);
  }

  await walk(absRoot, absRoot);
  return { files, directories };
}

export async function collectSourceFiles(
  root: string,
  ignoreFilter: Pick<Ignore, 'ignores'>,
): Promise<string[]> {
  return (await collectSourceTree(root, ignoreFilter)).files;
}
