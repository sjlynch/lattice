import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath } from '../projectPath.js';
import { listRoots } from './roots.js';
import type { DirListing } from './types.js';

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
