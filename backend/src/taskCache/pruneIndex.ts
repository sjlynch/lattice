// Junk-pruning for the ~/.lattice/projects.json index.
//
// The index accumulates entries that are not (and never will be) real Lattice
// projects: test/reproduction scratch under the OS temp dir, paths mangled by a
// shell (control characters, non-absolute), and phantom paths that a mangled
// request resolved to. The `performLoadKnownProjects` loader runs this at boot
// and drops the junk, then re-persists — so a restart self-cleans and the index
// can't grow without bound.
//
// The predicate is deliberately CONSERVATIVE so it can never drop a project the
// user cares about:
//   - A path that currently EXISTS on disk is always kept (even a non-git dir —
//     an index entry is harmless).
//   - A path with task data is always kept, EVEN IF its directory is gone. Task
//     data lives in ~/.lattice/per-project/<hash>/tasks.json, independent of the
//     project's drive, so a real project on a temporarily-offline network /
//     removable drive (which still has its tasks) survives.
//   - Only a path that is BOTH non-existent AND has no task data is treated as a
//     phantom — or one that is self-evidently malformed / temp-dir scratch.
// The worst case is dropping an empty index entry for an offline, task-less
// project; reopening it re-registers it and nothing is lost.

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { projectTasksFile } from './paths.js';

// True if the string contains any ASCII control character (NUL..US) — e.g. a
// CR/LF/tab left behind by shell mangling. No real filesystem path has one.
// Written as a char-code scan to keep control characters out of the source.
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

// Pure structural check — no filesystem access. True for a path that could
// never be a legitimate project root: empty, not absolute, containing control
// characters, or living under the OS temp directory (test / reproduction
// scratch).
export function isStructurallyJunkPath(
  canonical: string,
  tmpDir: string = os.tmpdir(),
): boolean {
  if (!canonical || !path.isAbsolute(canonical)) return true;
  if (hasControlChars(canonical)) return true;
  const tmp = canonicalProjectPath(tmpDir).toLowerCase();
  const c = canonical.toLowerCase();
  return c === tmp || c.startsWith(tmp + path.sep);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

// True if the project's home-scoped tasks.json holds at least one task. Missing
// or corrupt ⇒ treated as no tasks. Independent of whether the project's own
// directory exists (that's the whole point — it survives an offline drive).
export async function projectHasTasksOnDisk(canonical: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(projectTasksFile(canonical), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

// Full decision, used by the boot-time loader. Structurally-junk paths are
// pruned outright; otherwise a path is pruned only when it is BOTH gone from
// disk AND has no task data to preserve.
export async function shouldPruneProjectEntry(canonical: string): Promise<boolean> {
  if (isStructurallyJunkPath(canonical)) return true;
  if (await pathExists(canonical)) return false;
  if (await projectHasTasksOnDisk(canonical)) return false;
  return true;
}
