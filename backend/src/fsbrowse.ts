import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath } from './projectPath.js';

export type DirEntry = {
  name: string;
  path: string;
};

export type DirRoot = {
  name: string;
  path: string;
};

export type DirListing = {
  path: string;
  parent: string | null;
  roots: DirRoot[];
  entries: DirEntry[];
};

function rootEntry(rootPath: string): DirRoot {
  const canonical = canonicalProjectPath(rootPath);
  return {
    name: process.platform === 'win32' ? canonical.slice(0, 2) : canonical,
    path: canonical,
  };
}

async function listRoots(): Promise<DirRoot[]> {
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

function validateNewFolderName(name: string): string {
  const folderName = name.trim();
  if (!folderName) throw new Error('Folder name is required');
  if (folderName === '.' || folderName === '..') {
    throw new Error('Folder name must not be . or ..');
  }
  if (folderName.includes('/') || folderName.includes('\\') || path.basename(folderName) !== folderName) {
    throw new Error('Folder name must not include path separators');
  }
  if (/\0/.test(folderName)) {
    throw new Error('Folder name must not contain null bytes');
  }
  if (process.platform === 'win32') {
    if (/[<>:"|?*\x00-\x1F]/.test(folderName)) {
      throw new Error('Folder name contains characters Windows does not allow');
    }
    if (/[ .]$/.test(folderName)) {
      throw new Error('Folder name cannot end with a space or period on Windows');
    }
  }
  return folderName;
}

export async function listDir(target?: string): Promise<DirListing> {
  // Canonicalize so the frontend always sees uppercase-drive paths on
  // Windows. Without this, picking f:\foo vs F:\foo here would diverge from
  // the canonical task.projectPath produced by the tasks API and the
  // per-project filter (Sidebar) would hide spawn'd terminals.
  const abs = canonicalProjectPath(target && target.trim() ? target : os.homedir());
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const [dirents, roots] = await Promise.all([
    fs.readdir(abs, { withFileTypes: true }),
    listRoots(),
  ]);
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent,
    roots,
    entries,
  };
}

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
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('New folder must be inside the current directory');
  }

  await fs.mkdir(target);
  return listDir(target);
}
