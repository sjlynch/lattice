import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { listDir } from './listing.js';
import { validateNewFolderName } from './validation.js';
import type { DirListing } from './types.js';

export async function createDir(parent: string, name: string): Promise<DirListing> {
  if (!parent.trim()) throw new Error('Parent path is required');
  const base = canonicalProjectPath(parent.trim());
  const stat = await fs.stat(base);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${base}`);
  }

  const folderName = validateNewFolderName(name);
  const target = canonicalProjectPath(path.join(base, folderName));
  const relative = path.relative(base, target);
  // `..` as a whole SEGMENT is an escape; a folder named `..cache` is not.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('New folder must be inside the current directory');
  }

  await fs.mkdir(target);
  return listDir(target);
}
