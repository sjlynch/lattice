import crypto from 'node:crypto';
import path from 'node:path';
import { homeProjectScratchDir } from '../projectPath.js';
import { isPathStrictlyInside } from '../worktree/paths.js';

// Shared home-scoped scratch path helpers + the `.git`-deletion path-safety
// guard, used by the one-off agent run-types (pushRuns / qaRuns /
// postMergeHooks). Each of those was carrying its own byte-identical copy of
// `safeRelative` / `isPathInsideOrSame` / `isPathStrictlyInside` / id minting /
// root+dir construction / `assertSafe…Path`, differing only in the id prefix,
// scratch dir name, and log label. This is the single canonical implementation;
// the per-feature `paths.ts` files now just call `createHomeScratchPaths(...)`.
//
// The path guard is part of the repo's `.git`-deletion defence layer (see the
// root CLAUDE.md): it is what bounds the recursive scratch cleanup so it can
// never walk out of `~/.lattice/per-project/<hash>/<dir>/` toward the project's
// `.git`. Do not weaken it.

// --- pure relative-path guard primitives ---

// `path.relative` of two resolved paths, returning null for any input we won't
// reason about safely (non-strings, empties, embedded NUL).
export function safeRelative(
  basePath: string,
  targetPath: string,
): string | null {
  if (typeof basePath !== 'string' || typeof targetPath !== 'string') {
    return null;
  }
  if (!basePath || !targetPath) return null;
  if (basePath.includes('\0') || targetPath.includes('\0')) return null;
  return path.relative(path.resolve(basePath), path.resolve(targetPath));
}

// True when `targetPath` is `basePath` itself or strictly under it.
export function isPathInsideOrSame(
  basePath: string,
  targetPath: string,
): boolean {
  const rel = safeRelative(basePath, targetPath);
  if (rel === null) return false;
  if (rel === '') return true;
  return isPathStrictlyInside(basePath, targetPath);
}

// True when `targetPath` is strictly under `basePath` (not equal to it). This
// is the ONE canonical implementation (`worktree/paths.ts` — case-folded on
// win32, the same helper the worktree sweep/cleanup bounds use); this module
// used to carry its own copy without the fold. Re-exported so the per-feature
// `paths.ts` files and the tests keep their import path.
export { isPathStrictlyInside };

export type HomeScratchConfig = {
  // Scratch dir name under `~/.lattice/per-project/<hash>/` (e.g. 'push', 'qa',
  // 'post-merge-hooks').
  dirName: string;
  // Session-id prefix (e.g. 'push', 'qa', 'pmh'). Minted ids are
  // `<idPrefix>_<ts>_<hex>`; the guard refuses anything that doesn't match.
  idPrefix: string;
  // Log/error prefix (e.g. '[pushRuns]', '[qaRuns]', '[post-merge-hook]').
  logLabel: string;
  // Human noun for this scratch in safety errors (e.g. 'push session',
  // 'qa session', 'hook') — phrases the id/path/root descriptions.
  noun: string;
};

export type HomeScratchPaths = {
  dirName: string;
  createSessionId(): string;
  sessionsRoot(projectPath: string): string;
  sessionDir(projectPath: string, id: string): string;
  // Mint-and-verify: returns the resolved scratch dir for `id`, throwing if the
  // id is malformed, the dir isn't strictly under the home scratch root, or it
  // lands inside the project repo. This is what bounds the recursive cleanup so
  // it can never reach `.git`.
  assertSafeSessionPath(projectPath: string, id: string): string;
};

export function createHomeScratchPaths(
  config: HomeScratchConfig,
): HomeScratchPaths {
  const { dirName, idPrefix, logLabel, noun } = config;
  // idPrefix is always a fixed code literal ('push'/'qa'/'pmh'), so it carries
  // no regex-special characters.
  const idRe = new RegExp(`^${idPrefix}_\\d+_[0-9a-f]+$`);

  function sessionsRoot(projectPath: string): string {
    return homeProjectScratchDir(projectPath, dirName);
  }

  function sessionDir(projectPath: string, id: string): string {
    return path.join(sessionsRoot(projectPath), id);
  }

  function createSessionId(): string {
    return `${idPrefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  }

  function assertSafeSessionPath(projectPath: string, id: string): string {
    if (!idRe.test(id)) {
      throw new Error(
        `${logLabel} safety: refusing invalid ${noun} id: ${JSON.stringify(id)}.`,
      );
    }

    const resolvedRoot = path.resolve(sessionsRoot(projectPath));
    const resolvedDir = path.resolve(sessionDir(projectPath, id));
    const resolvedProject = path.resolve(projectPath);

    if (!isPathStrictlyInside(resolvedRoot, resolvedDir)) {
      throw new Error(
        `${logLabel} safety: refusing ${noun} path "${resolvedDir}" — ` +
          `it is not under the ${noun} scratch root "${resolvedRoot}".`,
      );
    }

    if (isPathInsideOrSame(resolvedProject, resolvedDir)) {
      throw new Error(
        `${logLabel} safety: refusing ${noun} path "${resolvedDir}" — ` +
          `it is inside the project repo "${resolvedProject}".`,
      );
    }

    return resolvedDir;
  }

  return {
    dirName,
    createSessionId,
    sessionsRoot,
    sessionDir,
    assertSafeSessionPath,
  };
}
