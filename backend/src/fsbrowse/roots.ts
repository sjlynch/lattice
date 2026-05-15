import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath } from '../projectPath.js';
import type { DirRoot } from './types.js';

export function rootEntry(rootPath: string): DirRoot {
  const canonical = canonicalProjectPath(rootPath);
  return {
    name: process.platform === 'win32' ? canonical.slice(0, 2) : canonical,
    path: canonical,
  };
}

export async function listRoots(): Promise<DirRoot[]> {
  if (process.platform !== 'win32') {
    const root = path.parse(os.homedir()).root || path.parse(process.cwd()).root || path.sep;
    return [rootEntry(root)];
  }

  const roots: DirRoot[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const driveRoot = `${String.fromCharCode(code)}:\\`;
    try {
      const stat = await fs.stat(driveRoot);
      if (stat.isDirectory()) roots.push(rootEntry(driveRoot));
    } catch {
      // Drive letters that do not exist (or are not currently accessible)
      // simply are not shown in the folder picker.
    }
  }

  if (roots.length === 0) {
    const fallback = path.parse(os.homedir()).root || path.parse(process.cwd()).root;
    if (fallback) roots.push(rootEntry(fallback));
  }

  return roots;
}
