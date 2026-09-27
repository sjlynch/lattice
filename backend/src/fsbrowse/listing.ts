import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalProjectPath, isRealAbsoluteProjectPath } from '../projectPath.js';
import { relativeProjectError } from '../routes/projectParam.js';
import { listRoots } from './roots.js';
import type { DirListing } from './types.js';

export async function listDir(target?: string): Promise<DirListing> {
  // Canonicalize so the frontend always sees uppercase-drive paths on
  // Windows. Without this, picking f:\foo vs F:\foo here would diverge from
  // the canonical task.projectPath produced by the tasks API and the
  // per-project filter (Sidebar) would hide spawn'd terminals.
  const requested = target && target.trim() ? target.trim() : os.homedir();
  // A relative path (typed into the picker's path box, or shell-stripped
  // backslashes) would resolve under the BACKEND's cwd and list a folder the
  // user never named — which they could then pick as a project. Bare
  // path.isAbsolute isn't enough on Windows: `\foo` and the Git-Bash `/d/proj`
  // pass it but resolve onto the backend's current drive.
  if (!isRealAbsoluteProjectPath(requested)) {
    throw new Error(relativeProjectError(requested));
  }
  const abs = canonicalProjectPath(requested);
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
