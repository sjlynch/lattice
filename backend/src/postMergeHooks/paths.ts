import crypto from 'node:crypto';
import path from 'node:path';
import { homeProjectScratchDir } from '../projectPath.js';

export const POST_MERGE_HOOKS_DIRNAME = 'post-merge-hooks';
const HOOK_RUN_ID_RE = /^pmh_\d+_[0-9a-f]+$/;

export function createPostMergeHookId(): string {
  return `pmh_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

export function postMergeHooksRoot(projectPath: string): string {
  return homeProjectScratchDir(projectPath, POST_MERGE_HOOKS_DIRNAME);
}

export function postMergeHookDir(projectPath: string, id: string): string {
  return path.join(postMergeHooksRoot(projectPath), id);
}

function safeRelative(basePath: string, targetPath: string): string | null {
  if (typeof basePath !== 'string' || typeof targetPath !== 'string') return null;
  if (!basePath || !targetPath) return null;
  if (basePath.includes('\0') || targetPath.includes('\0')) return null;
  return path.relative(path.resolve(basePath), path.resolve(targetPath));
}

function isPathStrictlyInside(basePath: string, targetPath: string): boolean {
  const rel = safeRelative(basePath, targetPath);
  return (
    rel !== null &&
    rel !== '' &&
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`)
  );
}

function isPathInsideOrSame(basePath: string, targetPath: string): boolean {
  const rel = safeRelative(basePath, targetPath);
  return (
    rel !== null &&
    (rel === '' ||
      (!path.isAbsolute(rel) &&
        rel !== '..' &&
        !rel.startsWith(`..${path.sep}`)))
  );
}

// Mirrors pushRuns/paths.ts: refuses to hand back a hook scratch path that
// isn't strictly inside the home-scoped post-merge-hooks root, or that lies
// inside the project repo. The hook *runs* with cwd=project, but its scratch
// dir (Stop hook config + instructions) is outside the repo so the recursive
// cleanup is bounded the same way push runs are.
export function assertSafePostMergeHookPath(
  projectPath: string,
  id: string,
): string {
  if (!HOOK_RUN_ID_RE.test(id)) {
    throw new Error(
      `[post-merge-hook] safety: refusing invalid hook id: ${JSON.stringify(id)}.`,
    );
  }
  const root = postMergeHooksRoot(projectPath);
  const dir = postMergeHookDir(projectPath, id);
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(dir);
  const resolvedProject = path.resolve(projectPath);

  if (!isPathStrictlyInside(resolvedRoot, resolvedDir)) {
    throw new Error(
      `[post-merge-hook] safety: refusing hook dir "${resolvedDir}" — ` +
        `not under hook scratch root "${resolvedRoot}".`,
    );
  }
  if (isPathInsideOrSame(resolvedProject, resolvedDir)) {
    throw new Error(
      `[post-merge-hook] safety: refusing hook dir "${resolvedDir}" — ` +
        `inside project repo "${resolvedProject}".`,
    );
  }
  return resolvedDir;
}
