import type { Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { exec, type ExecResult } from '../../worktree/exec.js';
import {
  DEFAULT_BASE_BRANCH,
  GIT_TIMEOUT_MS,
} from './worktreeModifiedConstants.js';
import {
  parseNulPaths,
  parsePorcelainPaths,
  toProjectAbsolutePaths,
} from './worktreeModifiedParsers.js';

export type GitExec = (
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export async function modifiedFilesForTask(
  task: Task,
  baseBranch: string,
  execFn: GitExec = exec,
): Promise<string[]> {
  if (!task.worktreePath) return [];
  const rels = new Set<string>();

  try {
    const committed = await execFn(
      'git',
      ['diff', '--name-only', '-z', `${baseBranch}...HEAD`],
      task.worktreePath,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (committed.code === 0) {
      for (const p of parseNulPaths(committed.stdout)) rels.add(p);
    }
  } catch {
    /* worktree gone / git error — fall through to status */
  }

  try {
    const status = await execFn(
      'git',
      ['status', '--porcelain=v1', '-z'],
      task.worktreePath,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (status.code === 0) {
      for (const p of parsePorcelainPaths(status.stdout)) rels.add(p);
    }
  } catch {
    /* ignore */
  }

  return toProjectAbsolutePaths(task.projectPath, rels);
}

export async function resolveBaseBranch(
  projectPath: string,
  execFn: GitExec = exec,
): Promise<string | null> {
  try {
    const r = await execFn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectPath, {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const name = r.stdout.trim();
    if (r.code === 0 && name && name !== 'HEAD') return name;
  } catch {
    /* fall through */
  }
  return null;
}

export function createBaseBranchResolver(execFn: GitExec = exec) {
  const cache = new Map<string, string>();

  const resolve = async (projectPath: string): Promise<string> => {
    const key = canonicalProjectPath(projectPath);
    const cached = cache.get(key);
    if (cached) return cached;

    const resolved = await resolveBaseBranch(projectPath, execFn);
    if (resolved) {
      cache.set(key, resolved);
      return resolved;
    }
    return DEFAULT_BASE_BRANCH;
  };

  return { resolve, clear: () => cache.clear() };
}

export const baseBranchResolver = createBaseBranchResolver();
