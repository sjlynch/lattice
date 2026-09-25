// `git init` + a starter `.gitignore` + a first commit, so a plain folder
// becomes a project Lattice can actually run tasks in.
//
// THE GIT-IDENTITY RULE. Lattice must never read or write a git identity — see
// `__tests__/gitIdentityUntouched.test.ts`, which greps every shipped backend
// source file for the config keys and env overrides involved and fails the
// build on a hit. That rules out even *probing* whether an identity exists
// (the probe would have to name the key on the command line). So we don't
// probe: we attempt the commit, and if it fails we recognize the cause from
// git's own stderr using markers that avoid the forbidden literals, then hand
// that raw stderr to the caller. Git's message already spells out the two
// commands to run; the frontend renders it and the user runs them in their own
// terminal. Do not route around that test.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import { exec, type ExecResult } from '../worktree/exec.js';
import {
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  projectGit,
} from '../worktree.js';
import { getCurrentBranch, rearmGitBranchWatcher } from '../gitBranch.js';
import { rearmGitStatusWatcher } from '../gitStatus.js';
import {
  clearStaleGitLocks,
  describeBlockingLocks,
  type StaleGitLockReport,
} from '../worktree/staleGitLocks.js';
import { buildStarterGitignore } from './gitignoreTemplate.js';
import { probeProjectGit } from './probe.js';
import { ProjectInitError, type ProjectInitResult } from './types.js';

// The quick calls (`init`, `diff --cached`, `rev-parse`).
const GIT_TIMEOUT_MS = 30_000;
// `add -A` and the first `commit` are the slow ones: the folder being adopted is
// often a large existing project, and `add` hashes every file into a loose
// object (on Windows, Defender scans each one) — a few GB / tens of thousands of
// files ran well past 30 s. A signed commit may also sit on a passphrase prompt.
// Killing them early left the repo unborn with nothing gained, so they get a
// generous bound instead.
export const GIT_SLOW_TIMEOUT_MS = 20 * 60_000;

// `exec` reports a timeout kill as code 124 (when the child left no exit code)
// and always appends this marker to stderr.
function isTimeoutKill(r: ExecResult): boolean {
  return r.code === 124 || /\[exec\] killed after \d+ms timeout/.test(r.stderr);
}

// Git's three phrasings for "I can't work out who is committing", matched
// without naming any of the config keys the identity scan forbids. Exported so
// the marker set can be pinned against git's real message text — since we're
// barred from asking git directly, this string match IS the detection.
const IDENTITY_FAILURE_RE =
  /Author identity unknown|Please tell me who you are|unable to auto-detect/i;

export function isMissingIdentityFailure(gitOutput: string): boolean {
  return IDENTITY_FAILURE_RE.test(gitOutput);
}

// `git init` cannot go through `projectGit`: that wrapper asserts `<root>/.git`
// exists (the very thing we're creating) and `init` is deliberately NOT on its
// whitelist. Same precedent as the first `rev-parse` in
// `worktree/setupProject.ts`. Do not add `init` to the whitelist — every other
// call below is a normal project-repo git call and goes through `projectGit`.
async function bareGit(cwd: string, args: string[]): Promise<ExecResult> {
  try {
    return await exec('git', args, cwd, { timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProjectInitError('git-unavailable', 'the `git` CLI is not on PATH');
    }
    throw err;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function lockMtimeMs(file: string): Promise<number | null> {
  try {
    const st = await fs.lstat(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

export type InitProjectGitOptions = {
  /** Text to write as `.gitignore`. Ignored when the project already has one. */
  gitignore?: string;
};

/** Injectable for tests; production always uses the defaults. */
export type InitProjectGitDeps = {
  projectGit: typeof projectGit;
  clearStaleGitLocks: (repoRoot: string) => Promise<StaleGitLockReport>;
};

const defaultDeps: InitProjectGitDeps = {
  projectGit,
  clearStaleGitLocks: (repoRoot) => clearStaleGitLocks(repoRoot),
};

export async function initProjectGit(
  project: string,
  opts: InitProjectGitOptions = {},
  deps: InitProjectGitDeps = defaultDeps,
): Promise<ProjectInitResult> {
  const root = canonicalProjectPath(project);
  // Two browser tabs (or the chip and a task-create interception) can fire
  // this at the same moment; a second `git init` racing the first commit would
  // wedge on `.git/index.lock` at best.
  return runExclusive(`projectInit:${root}`, () => runInit(root, opts, deps));
}

// Run `add -A` / `commit` under the long bound. A timeout SIGKILLs git
// mid-write, and a killed git leaves `.git/index.lock` behind — which made
// every retry fail at once with "Unable to create '…/index.lock': File exists",
// so the folder could never be initialized. We hold this project's init lock
// (`runExclusive`), so a lock that was absent before this call and is present
// after the kill is the one the killed git took: remove it (a single-file
// unlink, never recursive) and report the timeout in words, not the raw kill.
async function runSlowGit(
  root: string,
  args: string[],
  deps: InitProjectGitDeps,
): Promise<ExecResult> {
  const dir = await deps.projectGit(root, ['rev-parse', '--absolute-git-dir'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const gitDir = dir.code === 0 ? dir.stdout.trim() : '';
  const lock = gitDir ? path.join(path.resolve(root, gitDir), 'index.lock') : null;
  const lockBefore = lock ? await lockMtimeMs(lock) : null;

  const result = await deps.projectGit(root, args, { timeoutMs: GIT_SLOW_TIMEOUT_MS });
  if (!isTimeoutKill(result)) return result;

  if (lock && lockBefore === null && (await lockMtimeMs(lock)) !== null) {
    try {
      await fs.unlink(lock);
      console.warn(`[projectInit] removed ${lock} left by the timed-out \`git ${args[0]}\``);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[projectInit] could not remove ${lock}:`, err);
      }
    }
  }

  const minutes = Math.round(GIT_SLOW_TIMEOUT_MS / 60_000);
  const hint =
    args[0] === 'commit'
      ? 'If your commits are signed, check for a passphrase prompt waiting for you.'
      : 'The folder is probably too large to commit in one go — add big or generated ' +
        'folders to .gitignore, or run `git add -A` and `git commit` yourself in a terminal.';
  throw new ProjectInitError(
    'git-failed',
    `git ${args[0]} took longer than ${minutes} minutes and was stopped. ` +
      `Nothing was committed; you can try again. ${hint}`,
    result.stderr.trim() || result.stdout.trim(),
  );
}

async function runInit(
  root: string,
  opts: InitProjectGitOptions,
  deps: InitProjectGitDeps,
): Promise<ProjectInitResult> {
  // Re-probe inside the lock: the caller's preview may be seconds old, and the
  // loser of a two-tab race must see the repo the winner just created.
  const probe = await probeProjectGit(root);
  if (probe.state === 'unavailable') {
    throw new ProjectInitError(
      'git-unavailable',
      probe.reason ?? 'the `git` CLI is not on PATH',
    );
  }
  // Two ways in: a plain folder (`none` + initable → `git init` first), or a
  // repo whose HEAD is still unborn (`repo` + `unborn` → skip `git init`, the
  // rest of the flow is exactly the first commit that never landed). The
  // latter is what a failed first commit leaves behind — most often a missing
  // git identity — and is the only way to make that project usable again
  // without leaving Lattice.
  const finishingUnborn = probe.state === 'repo' && probe.unborn === true && probe.initable;
  if (!finishingUnborn && (probe.state !== 'none' || !probe.initable)) {
    throw new ProjectInitError(
      'not-initable',
      probe.reason ?? `cannot initialize a git repository at ${root} (${probe.state})`,
    );
  }

  if (finishingUnborn) {
    // A previous attempt whose git was killed without `runSlowGit`'s cleanup
    // (an older build's timeout, a crash, a closed terminal) leaves
    // `index.lock` behind, and `add -A` would fail on it immediately. Clear abandoned locks;
    // one still held — or too recent to call abandoned — gets a clear error
    // instead of git's raw "File exists".
    const { blocking } = await deps.clearStaleGitLocks(root);
    if (blocking.length > 0) {
      throw new ProjectInitError(
        'git-failed',
        `git is locked by another operation: ${describeBlockingLocks(blocking)}. ` +
          'Wait for it to finish (or delete the lock file if no git command is running) and try again.',
      );
    }
  } else {
    let init = await bareGit(root, ['init', '-b', 'main']);
    if (init.code !== 0) {
      // `-b` landed in git 2.28; on an older git fall back and report whichever
      // branch name it defaults to.
      init = await bareGit(root, ['init']);
    }
    if (init.code !== 0) {
      throw new ProjectInitError(
        'git-failed',
        'git init failed',
        init.stderr.trim() || init.stdout.trim(),
      );
    }
  }

  const ignorePath = path.join(root, '.gitignore');
  // An explicit `gitignore` always wins, even over a file already on disk. It
  // only ever comes from the dialog, where the user was shown that exact text
  // and the file/byte count it produces — so discarding it would mean the count
  // they approved was a lie about what the commit captures, which is the one
  // failure this preview exists to prevent (they exclude `.env`, watch the count
  // drop, and it gets committed anyway). With no explicit text, a `.gitignore`
  // the project brought is left exactly as it is.
  if (opts.gitignore !== undefined || !(await fileExists(ignorePath))) {
    const text = opts.gitignore ?? (await buildStarterGitignore(root));
    await fs.writeFile(ignorePath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  }
  // Unconditional, and it has to run before `add -A`. Two ways `.lattice/` ends
  // up unignored otherwise: the project brought its own `.gitignore` (never
  // overwrite that), or the user edited Lattice's entries out of the text the
  // dialog showed them. Either way the first commit would capture
  // health-cache.json / userSettings.json. Idempotent — appends only what's
  // missing, and no-ops when the file already covers everything.
  await ensureLatticeGitignore(root);
  // Now possible — it writes into `.git/info/exclude`, which only exists once
  // `git init` has run.
  await ensureLatticeRepoExclude(root);

  const add = await runSlowGit(root, ['add', '-A'], deps);
  if (add.code !== 0) {
    throw new ProjectInitError(
      'git-failed',
      'git add failed',
      add.stderr.trim() || add.stdout.trim(),
    );
  }
  const staged = await deps.projectGit(root, ['diff', '--cached', '--name-only'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const filesCommitted =
    staged.code === 0
      ? staged.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length
      : 0;

  const commitArgs = ['commit', '-m', 'Initial commit'];
  // An empty new project stages nothing, and a repo with no commit is useless
  // to Lattice — `worktree/setupAdd.ts` fails loudly on an unborn HEAD.
  if (filesCommitted === 0) commitArgs.push('--allow-empty');
  const committed = await runSlowGit(root, commitArgs, deps);
  if (committed.code !== 0) {
    const output = `${committed.stderr}\n${committed.stdout}`;
    const detail = committed.stderr.trim() || committed.stdout.trim();
    if (isMissingIdentityFailure(output)) {
      throw new ProjectInitError(
        'git-identity-missing',
        'git could not determine who is making the commit',
        detail,
      );
    }
    throw new ProjectInitError('git-failed', 'git commit failed', detail);
  }

  const sha = await deps.projectGit(root, ['rev-parse', '--short', 'HEAD'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const commit = sha.code === 0 && sha.stdout.trim() ? sha.stdout.trim() : null;

  // The navbar chip and the timeline scrubber arm their watchers lazily and
  // per project; both subscribed to a folder that had no `.git`, so without
  // this they stay dead until the user reloads the page.
  try {
    await Promise.all([rearmGitBranchWatcher(root), rearmGitStatusWatcher(root)]);
  } catch (err) {
    console.warn('[projectInit] could not re-arm the git watchers:', err);
  }

  return {
    toplevel: root,
    branch: (await getCurrentBranch(root)) ?? '',
    commit,
    filesCommitted,
  };
}
