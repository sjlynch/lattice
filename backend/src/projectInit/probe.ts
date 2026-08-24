// "Is this folder a git repo, and if not, may we make one?"
//
// The walk-up check is the whole point of this module. `fs.stat(<project>/.git)`
// alone reports "no repo" for a subdirectory of a monorepo, and running
// `git init` there would create a nested repo that the parent then sees as a
// gitlink — a commit that captures nothing but a bare submodule pointer, and
// the single worst outcome this feature can produce. `git rev-parse
// --show-toplevel` walks up, so only it can tell 'none' from 'nested'.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec, type ExecResult } from '../worktree/exec.js';
import { canonicalProjectPath } from '../projectPath.js';
import { refuseInitReason } from './guards.js';
import type { ProjectGitProbe } from './types.js';

const GIT_PROBE_TIMEOUT_MS = 5_000;

class GitBinaryMissingError extends Error {}

// Plain `exec`, never `projectGit`: there is no `.git` to assert on yet, which
// is the entire question being asked. Same precedent as the first `rev-parse`
// in `worktree/setupProject.ts`.
async function probeGit(cwd: string, args: string[]): Promise<ExecResult> {
  try {
    return await exec('git', args, cwd, { timeoutMs: GIT_PROBE_TIMEOUT_MS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GitBinaryMissingError('the `git` CLI is not on PATH');
    }
    throw err;
  }
}

export async function probeProjectGit(project: string): Promise<ProjectGitProbe> {
  const canonical = canonicalProjectPath(project);

  // Fast path: a `.git` entry here means this folder IS the repo root, so the
  // common case (every already-adopted project) costs one stat and no spawn.
  // A `.git` FILE counts too — that's a linked worktree / submodule pointer,
  // and it's still a working repo.
  try {
    const st = await fs.stat(path.join(canonical, '.git'));
    if (st.isDirectory() || st.isFile()) {
      return { state: 'repo', toplevel: canonical, initable: false };
    }
  } catch {
    /* no `.git` here — fall through to the walk-up check */
  }

  // Spawning with a non-existent cwd fails as ENOENT, which we would otherwise
  // misread as "git is not installed". Settle the question here instead.
  try {
    const st = await fs.stat(canonical);
    if (!st.isDirectory()) {
      return { state: 'error', initable: false, reason: `${canonical} is not a directory` };
    }
  } catch {
    return { state: 'error', initable: false, reason: `${canonical} does not exist` };
  }

  try {
    // Ask about bareness first: a bare repo has no work tree, so
    // `--show-toplevel` fails inside one with a message that has nothing to do
    // with "not a repository" and would land us in 'error'.
    const bare = await probeGit(canonical, ['rev-parse', '--is-bare-repository']);
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      return {
        state: 'bare',
        toplevel: canonical,
        initable: false,
        reason: `${canonical} is a bare repository — it has no working tree for Lattice to run tasks in`,
      };
    }

    const top = await probeGit(canonical, ['rev-parse', '--show-toplevel']);
    if (top.code === 0 && top.stdout.trim()) {
      const toplevel = canonicalProjectPath(top.stdout.trim());
      return {
        state: 'nested',
        toplevel,
        initable: false,
        reason:
          `${canonical} is already inside the git repository at ${toplevel}. ` +
          `Initializing here would create a nested repo that ${toplevel} sees as ` +
          `a bare gitlink; open the repo root instead.`,
      };
    }

    const stderr = `${bare.stderr}\n${top.stderr}`;
    if (/not a git repository/i.test(stderr)) {
      const reason = await refuseInitReason(canonical);
      return reason
        ? { state: 'none', initable: false, reason }
        : { state: 'none', initable: true };
    }

    return {
      state: 'error',
      initable: false,
      reason: stderr.trim() || `git rev-parse exited ${top.code}`,
    };
  } catch (err) {
    if (err instanceof GitBinaryMissingError) {
      return { state: 'unavailable', initable: false, reason: err.message };
    }
    return { state: 'error', initable: false, reason: (err as Error).message };
  }
}
