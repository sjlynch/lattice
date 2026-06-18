import crypto from 'node:crypto';
import path from 'node:path';
import { homeProjectScratchDir } from '../projectPath.js';

// QA e2e-run scratch lives at `~/.lattice/per-project/<hash>/qa/<id>/` —
// home-scoped, OUTSIDE the repo, so the bounded recursive cleanup can never
// reach the project tree (mirrors pushRuns/paths.ts).
export const QA_RUNS_DIRNAME = 'qa';
const QA_SESSION_ID_RE = /^qa_\d+_[0-9a-f]+$/;

export function createQaSessionId(): string {
  return `qa_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

export function qaSessionsRoot(projectPath: string): string {
  return homeProjectScratchDir(projectPath, QA_RUNS_DIRNAME);
}

export function qaSessionDir(projectPath: string, id: string): string {
  return path.join(qaSessionsRoot(projectPath), id);
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

export function assertSafeQaSessionPath(
  projectPath: string,
  id: string,
): string {
  if (!QA_SESSION_ID_RE.test(id)) {
    throw new Error(
      `[qaRuns] safety: refusing invalid qa session id: ${JSON.stringify(id)}.`,
    );
  }

  const root = qaSessionsRoot(projectPath);
  const dir = qaSessionDir(projectPath, id);
  const resolvedRoot = path.resolve(root);
  const resolvedDir = path.resolve(dir);
  const resolvedProject = path.resolve(projectPath);

  if (!isPathStrictlyInside(resolvedRoot, resolvedDir)) {
    throw new Error(
      `[qaRuns] safety: refusing qa session path "${resolvedDir}" — ` +
        `it is not under the Lattice qa scratch root "${resolvedRoot}".`,
    );
  }

  if (isPathInsideOrSame(resolvedProject, resolvedDir)) {
    throw new Error(
      `[qaRuns] safety: refusing qa session path "${resolvedDir}" — ` +
        `it is inside the project repo "${resolvedProject}".`,
    );
  }

  return resolvedDir;
}
