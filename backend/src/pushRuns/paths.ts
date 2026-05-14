import crypto from 'node:crypto';
import path from 'node:path';
import { homeProjectScratchDir } from '../projectPath.js';

export const PUSH_RUNS_DIRNAME = 'push';
const PUSH_SESSION_ID_RE = /^push_\d+_[0-9a-f]+$/;

export function createPushSessionId(): string {
  return `push_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

export function pushSessionsRoot(projectPath: string): string {
  return homeProjectScratchDir(projectPath, PUSH_RUNS_DIRNAME);
}

export function pushSessionDir(projectPath: string, id: string): string {
  return path.join(pushSessionsRoot(projectPath), id);
}

function safeRelative(basePath: string, targetPath: string): string | null {
  if (typeof basePath !== 'string' || typeof targetPath !== 'string') {
    return null;
  }
  if (!basePath || !targetPath) return null;
  if (basePath.includes('\0') || targetPath.includes('\0')) return null;
  return path.relative(path.resolve(basePath), path.resolve(targetPath));
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

export function assertSafePushSessionPath(
  projectPath: string,
  id: string,
): string {
  if (!PUSH_SESSION_ID_RE.test(id)) {
    throw new Error(
      `[pushRuns] safety: refusing invalid push session id: ${JSON.stringify(id)}.`,
    );
  }

  const root = pushSessionsRoot(projectPath);
  const dir = pushSessionDir(projectPath, id);
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(dir);
  const resolvedProject = path.resolve(projectPath);

  if (!isPathStrictlyInside(resolvedRoot, resolvedDir)) {
    throw new Error(
      `[pushRuns] safety: refusing push session path "${resolvedDir}" — ` +
        `it is not under the Lattice push scratch root "${resolvedRoot}".`,
    );
  }

  if (isPathInsideOrSame(resolvedProject, resolvedDir)) {
    throw new Error(
      `[pushRuns] safety: refusing push session path "${resolvedDir}" — ` +
        `it is inside the project repo "${resolvedProject}".`,
    );
  }

  return resolvedDir;
}
