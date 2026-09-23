// Read-only git probes of the project's main checkout for the Run tests step.
// Everything goes through `projectGit` (the whitelisted project-repo wrapper;
// all of these are on its read list) and every failure degrades to "unknown"
// rather than throwing — a probe must never stop the workflow (D4).

import { projectGit } from '../../worktree/projectGit.js';
import { parsePorcelainZ } from './userWip.js';

const GIT_PROBE_TIMEOUT_MS = 60_000;

// The HEAD commit, or null when it can't be read: an unborn branch (a fresh
// `git init` with no commit), no repo, or git failing. Null means "run the
// tests" to the skip rule — never "skip".
export async function readProjectHead(projectPath: string): Promise<string | null> {
  try {
    const r = await projectGit(projectPath, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// True only when HEAD is positively DETACHED. Merges fast-forward whatever
// branch the checkout is on and refuse a detached HEAD
// (`worktree/merge/preflight.ts` `assertMainOnBranch`), so a detached checkout
// has no branch for Run tests to commit onto. `symbolic-ref -q` exits 1 for a
// detached HEAD and 128 for real errors — those (and a missing repo) read as
// "not known to be detached" so the step still runs.
export async function isProjectHeadDetached(projectPath: string): Promise<boolean> {
  try {
    const r = await projectGit(projectPath, ['symbolic-ref', '-q', 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    return r.code === 1 && !r.stdout.trim();
  } catch {
    return false;
  }
}

// Every modified / staged / untracked path, or null when status can't be read.
export async function readProjectStatusPaths(projectPath: string): Promise<string[] | null> {
  try {
    const r = await projectGit(projectPath, ['status', '--porcelain=v1', '-z'], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
    return r.code === 0 ? parsePorcelainZ(r.stdout) : null;
  } catch {
    return null;
  }
}

export type StepCommit = { sha: string; subject: string; files: string[] };

// `git log -z --name-only --format=<RS>%h<TAB>%s` output → commits (newest
// first). Each record starts with the 0x1E separator; the header ends at the
// first NUL and the files follow, NUL-separated, after a newline.
export function parseLogNameOnlyZ(stdout: string): StepCommit[] {
  const out: StepCommit[] = [];
  for (const chunk of stdout.split('\x1e')) {
    if (!chunk) continue;
    const headerEnd = chunk.indexOf('\0');
    const header = headerEnd === -1 ? chunk : chunk.slice(0, headerEnd);
    const rest = headerEnd === -1 ? '' : chunk.slice(headerEnd + 1);
    const tab = header.indexOf('\t');
    const sha = (tab === -1 ? header : header.slice(0, tab)).trim();
    if (!sha) continue;
    const subject = tab === -1 ? '' : header.slice(tab + 1).trim();
    const files = rest.replace(/^\n/, '').split('\0').map((f) => f.replace(/^\n/, '')).filter(Boolean);
    out.push({ sha, subject, files });
  }
  return out;
}

// Commits reachable from HEAD but not from `startHead` (what the step made),
// newest first, capped. Null when git can't answer.
export async function readCommitsSince(
  projectPath: string,
  startHead: string,
  limit = 50,
): Promise<StepCommit[] | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(startHead)) return null;
  try {
    const r = await projectGit(
      projectPath,
      ['log', '-z', '--name-only', '--no-renames', `--max-count=${limit}`, '--format=%x1e%h%x09%s', `${startHead}..HEAD`],
      { timeoutMs: GIT_PROBE_TIMEOUT_MS },
    );
    return r.code === 0 ? parseLogNameOnlyZ(r.stdout) : null;
  } catch {
    return null;
  }
}
