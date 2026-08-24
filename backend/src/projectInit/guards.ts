// Path guards for `git init`. A repo is cheap to create and expensive to
// notice: `git init` in the wrong directory quietly turns a home dir, a
// system tree, or Lattice's own state dir into a repo whose `git add -A`
// would then try to track everything beneath it. None of these places is
// ever a project, so refuse them outright rather than trusting the caller.
//
// Returns a human-readable reason (rendered straight into the dialog and the
// probe's `reason`), or null when the path is safe to initialize.

import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectPath, latticeHomeDir } from '../projectPath.js';

function samePath(a: string, b: string): boolean {
  // Windows paths are case-insensitive; everywhere else they are not.
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Trees no project ever lives in. `SystemDrive`/`SystemRoot` are consulted so
// a machine booted from D: is covered too, with the documented C: defaults as
// the fallback.
function windowsProtectedTrees(): string[] {
  const drive = `${process.env.SystemDrive || 'C:'}${path.sep}`;
  return [
    process.env.SystemRoot || path.join(drive, 'Windows'),
    path.join(drive, 'Program Files'),
    path.join(drive, 'Program Files (x86)'),
  ].map((p) => canonicalProjectPath(p));
}

// `C:\Users` itself is refused, but NOT its contents — a project under
// `C:\Users\<me>\dev` is the normal case.
function windowsProtectedExact(): string[] {
  const drive = `${process.env.SystemDrive || 'C:'}${path.sep}`;
  return [canonicalProjectPath(path.join(drive, 'Users'))];
}

export async function refuseInitReason(
  canonicalPath: string,
): Promise<string | null> {
  const p = canonicalPath;
  if (!p || !path.isAbsolute(p)) {
    return 'the project path must be absolute';
  }

  if (samePath(path.parse(p).root, p)) {
    return `${p} is a filesystem root — a repo here would try to track the whole volume`;
  }

  const home = canonicalProjectPath(os.homedir());
  if (samePath(home, p)) {
    return `${p} is your home directory — a repo here would try to track every file in it`;
  }

  // Worktrees, snapshots, git bundles and per-run scratch all live here. A
  // repo over the top of them would sweep Lattice's own state into commits.
  const lattice = canonicalProjectPath(latticeHomeDir());
  if (samePath(lattice, p) || isUnder(p, lattice)) {
    return `${p} is inside Lattice's own state directory (${lattice})`;
  }

  if (process.platform === 'win32') {
    for (const dir of windowsProtectedTrees()) {
      if (samePath(dir, p) || isUnder(p, dir)) {
        return `${p} is inside a Windows system directory (${dir})`;
      }
    }
    for (const dir of windowsProtectedExact()) {
      if (samePath(dir, p)) {
        return `${p} holds every account's profile — pick a folder inside your own`;
      }
    }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(p);
  } catch {
    return `${p} does not exist`;
  }
  if (!stat.isDirectory()) return `${p} is not a directory`;

  // Catches the obvious unwritable cases (read-only volume/attribute). On
  // Windows this does not consult ACLs, so `git init` can still fail with
  // EPERM — which surfaces as a `git-failed` with git's own message.
  try {
    await fs.access(p, fsConstants.W_OK);
  } catch {
    return `${p} is not writable`;
  }

  return null;
}
