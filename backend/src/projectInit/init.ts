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
import { buildStarterGitignore } from './gitignoreTemplate.js';
import { probeProjectGit } from './probe.js';
import { ProjectInitError, type ProjectInitResult } from './types.js';

const GIT_TIMEOUT_MS = 30_000;

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

export type InitProjectGitOptions = {
  /** Text to write as `.gitignore`. Ignored when the project already has one. */
  gitignore?: string;
};

export async function initProjectGit(
  project: string,
  opts: InitProjectGitOptions = {},
): Promise<ProjectInitResult> {
  const root = canonicalProjectPath(project);
  // Two browser tabs (or the chip and a task-create interception) can fire
  // this at the same moment; a second `git init` racing the first commit would
  // wedge on `.git/index.lock` at best.
  return runExclusive(`projectInit:${root}`, () => runInit(root, opts));
}

async function runInit(
  root: string,
  opts: InitProjectGitOptions,
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
  if (probe.state !== 'none' || !probe.initable) {
    throw new ProjectInitError(
      'not-initable',
      probe.reason ?? `cannot initialize a git repository at ${root} (${probe.state})`,
    );
  }

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

  const add = await projectGit(root, ['add', '-A'], { timeoutMs: GIT_TIMEOUT_MS });
  if (add.code !== 0) {
    throw new ProjectInitError(
      'git-failed',
      'git add failed',
      add.stderr.trim() || add.stdout.trim(),
    );
  }
  const staged = await projectGit(root, ['diff', '--cached', '--name-only'], {
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
  const committed = await projectGit(root, commitArgs, { timeoutMs: GIT_TIMEOUT_MS });
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

  const sha = await projectGit(root, ['rev-parse', '--short', 'HEAD'], {
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
