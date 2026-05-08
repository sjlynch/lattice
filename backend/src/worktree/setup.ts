// Worktree creation: takes a Task and produces an isolated git worktree
// + branch + Claude Stop-hook config + LATTICE_TASK.md brief.
//
// Reconciles stale state from a prior half-failed run before creating, so
// that "Run" is always a fresh start. Resume uses a different code path
// (in routes/tasks.ts) that preserves prior progress.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from '../tasks.js';
import { exec } from './exec.js';
import { worktreeExists } from './state.js';
import { renderTaskMarkdown } from './instructions.js';
import { proxyKillSessionsByCwd } from '../terminalProxy.js';
import {
  LATTICE_EXCLUDE_PATTERNS,
  LATTICE_GITIGNORE_ENTRIES,
  LATTICE_OWNED_FILE_PATHS,
} from './managedFiles.js';

// How many alternate worktree paths to try when the canonical path can't be
// freed (Windows lock that survives PTY kills + retries — usually an Explorer
// window or the user's editor). 4 retries gives us "-r2" through "-r5",
// after which the user almost certainly has a runaway process and should be
// told to look rather than us silently spawning more orphans.
const MAX_PATH_RETRY_SUFFIXES = 4;
const RM_RETRY_DELAYS_MS = [150, 400, 900];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

export type WorktreeResult = {
  worktreePath: string;
  branch: string;
  taskFile: string;
};

export type ParsedWorktree = {
  path: string;
  branch?: string;
  detached?: boolean;
};

// Parse `git worktree list --porcelain` into an array of {path, branch?}.
// Each block is separated by a blank line and looks like:
//
//   worktree /abs/path
//   HEAD <sha>
//   branch refs/heads/<name>          (or 'detached')
//
// Used by setupTaskWorktree to recover from stale worktrees that survived
// a previous half-failed run.
export function parseWorktreesPorcelain(out: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const entry: ParsedWorktree = { path: '' };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim();
      } else if (line === 'detached') {
        entry.detached = true;
      }
    }
    if (entry.path) result.push(entry);
  }
  return result;
}

export async function setupTaskWorktree(
  repoPath: string,
  task: Task,
  backendOrigin: string,
): Promise<WorktreeResult> {
  const repoCheck = await exec(
    'git',
    ['rev-parse', '--show-toplevel'],
    repoPath,
  );
  if (repoCheck.code !== 0) {
    throw new Error(
      `Not a git repository: ${repoPath}. Initialize one with \`git init\` first.`,
    );
  }
  const repoRoot = repoCheck.stdout.trim();
  // Defend the project against the file-tracking pattern that produces
  // unresolvable merge conflicts in `.claude/settings.local.json`. Cheap,
  // idempotent, and runs before each worktree creation so newly-adopted
  // projects self-heal on first task run.
  await ensureLatticeGitignore(repoRoot);
  await untrackOwnedFilesInRepo(repoRoot);
  const slug = slugify(task.title);
  const shortId = task.id.slice(-6);
  const worktreesDir = path.join(repoRoot, '.lattice', 'worktrees');
  await fs.mkdir(worktreesDir, { recursive: true });

  // Try the canonical path first; if reconciliation can't free it (Windows
  // file lock from an Explorer window, editor, etc.), fall through to a
  // suffixed path so the user isn't blocked. The branch name follows the
  // same retry suffix so `git worktree add -b` doesn't collide either.
  for (let attempt = 0; attempt <= MAX_PATH_RETRY_SUFFIXES; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-r${attempt + 1}`;
    const candidatePath = path.join(worktreesDir, `${slug}-${shortId}${suffix}`);
    const candidateBranch = `lattice/${slug}-${shortId}${suffix}`;

    const reconciled = await reconcileStaleState(
      repoRoot,
      candidateBranch,
      candidatePath,
    );
    if (!reconciled) {
      // Path or branch couldn't be cleaned. Try the next suffix.
      console.warn(
        `[worktree] could not reconcile ${candidatePath}; trying next suffix`,
      );
      continue;
    }

    const wt = await exec(
      'git',
      ['worktree', 'add', candidatePath, '-b', candidateBranch],
      repoRoot,
    );
    if (wt.code !== 0) {
      // `git worktree add` itself failed (rare after reconcile). Log and
      // try the next suffix rather than throwing — same recovery model.
      console.warn(
        `[worktree] git worktree add ${candidatePath} -b ${candidateBranch} ` +
          `(cwd=${repoRoot}) exit ${wt.code}: ` +
          `${wt.stderr.trim() || wt.stdout.trim() || '(no output)'}; ` +
          `trying next suffix`,
      );
      continue;
    }

    const taskFile = path.join(candidatePath, 'LATTICE_TASK.md');
    await fs.writeFile(taskFile, renderTaskMarkdown(task, backendOrigin), 'utf8');
    await installStopHook(candidatePath, task.id, backendOrigin);
    // Keep Lattice-managed files out of `git status` so Claude's `git add .`
    // never stages them. Writes to the worktree-local exclude (not the repo
    // .gitignore) so the project's tracked files are untouched.
    await writeWorktreeExclude(candidatePath, [...LATTICE_EXCLUDE_PATTERNS]);

    if (attempt > 0) {
      console.log(
        `[worktree] used fallback path ${candidatePath} for task ${task.id} ` +
          `(canonical was locked; orphan dir at .lattice/worktrees/${slug}-${shortId} ` +
          `will need manual cleanup once the lock holder is closed)`,
      );
    }

    return {
      worktreePath: candidatePath,
      branch: candidateBranch,
      taskFile,
    };
  }

  throw new Error(
    `Could not create a worktree for task "${task.title}" after ` +
      `${MAX_PATH_RETRY_SUFFIXES + 1} attempts: every candidate path under ` +
      `.lattice/worktrees/${slug}-${shortId}* is locked or unusable. ` +
      `Close any process / editor / Explorer window holding those directories ` +
      `open and try again.`,
  );
}

// Branch names are deterministic from (slug, shortId), so a leftover
// branch/worktree from before will collide with `git worktree add -b`.
// Run = fresh start; the explicit Resume path is the one that
// preserves prior progress.
//
// Returns true if the (path, branch) pair is now free for `git worktree add`,
// false if something on disk couldn't be removed (Windows lock that survived
// PTY kills + retries). Caller falls back to an alternate suffix.
async function reconcileStaleState(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
): Promise<boolean> {
  const branchExists =
    (
      await exec(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        repoRoot,
      )
    ).code === 0;
  const targetDirExists = await worktreeExists(worktreePath);

  if (!branchExists && !targetDirExists) return true;

  const wtList = await exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    repoRoot,
  );
  const tracked = parseWorktreesPorcelain(wtList.stdout);
  const onBranch = tracked.find(
    (w) => w.branch === `refs/heads/${branchName}`,
  );
  if (onBranch) {
    // Tracked worktree on this branch — remove it cleanly first.
    // Kill any PTYs whose cwd is inside the dir before git tries to remove it,
    // otherwise on Windows the cwd lock makes `git worktree remove` fail.
    await proxyKillSessionsByCwd(onBranch.path);
    await new Promise<void>((r) => setTimeout(r, 200));
    const rm = await exec(
      'git',
      ['worktree', 'remove', '--force', onBranch.path],
      repoRoot,
    );
    if (rm.code !== 0) {
      console.warn(
        `[worktree] reconcile: 'git worktree remove --force ${onBranch.path}' ` +
          `exit ${rm.code}: ${rm.stderr.trim() || rm.stdout.trim()}`,
      );
    }
  }
  if (await worktreeExists(worktreePath)) {
    // Untracked stray directory at our target path — wipe it. This is the
    // path most likely to hit EBUSY: the qa-cleanup background job already
    // tried (and may have failed) once, leaving the dir orphaned. Kill any
    // PTYs whose cwd is inside, give the OS a beat, then retry the rm a
    // few times before giving up.
    //
    // Safety: worktreePath is always candidatePath (path.join(worktreesDir,
    // ...)) so this check should never trigger under normal operation. It is
    // here as a belt-and-suspenders guard matching the one in cleanup.ts.
    const resolvedWt = path.resolve(worktreePath);
    const resolvedBase = path.resolve(path.join(repoRoot, '.lattice', 'worktrees'));
    if (!resolvedWt.startsWith(resolvedBase + path.sep)) {
      console.error(
        `[worktree] reconcile: refusing rm on "${resolvedWt}" — ` +
          `not under "${resolvedBase}". Skipping cleanup.`,
      );
      return false;
    }
    await proxyKillSessionsByCwd(worktreePath);
    await new Promise<void>((r) => setTimeout(r, 200));
    if (!(await tryRmWithRetries(worktreePath))) {
      // Caller will move on to a fresh suffix; leave the orphan dir in
      // place so the user can investigate the lock holder.
      return false;
    }
  }
  await exec('git', ['worktree', 'prune'], repoRoot);
  if (branchExists) {
    // -D in case it has unmerged commits from a prior abandoned run.
    const del = await exec('git', ['branch', '-D', branchName], repoRoot);
    if (del.code !== 0) {
      console.warn(
        `[worktree] reconcile: 'git branch -D ${branchName}' ` +
          `exit ${del.code}: ${del.stderr.trim() || del.stdout.trim()}`,
      );
      return false;
    }
  }
  return true;
}

// `fs.rm` on Windows fails with EBUSY/EPERM/ENOTEMPTY when something
// holds a handle on the directory. Most lock holders we care about (PTYs)
// have already been killed by the caller; this gives the OS a few hundred
// ms to actually release the handle before declaring defeat.
async function tryRmWithRetries(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < RM_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient =
        code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || attempt === RM_RETRY_DELAYS_MS.length) {
        console.warn(`[worktree] fs.rm ${target} failed (${code ?? 'unknown'}):`, err);
        return false;
      }
      await new Promise<void>((r) =>
        setTimeout(r, RM_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
  return false;
}

// Write patterns to the worktree-local git exclude file so these files
// are invisible to `git status` inside the worktree. The exclude file
// lives in the worktree's gitdir (resolved from the .git pointer file)
// and is never committed — unlike .gitignore which is part of the tree.
async function writeWorktreeExclude(worktreePath: string, patterns: string[]): Promise<void> {
  try {
    const gitPointer = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const gitDirRelative = gitPointer.trim().replace(/^gitdir:\s*/i, '');
    const gitDir = path.resolve(worktreePath, gitDirRelative);
    const infoDir = path.join(gitDir, 'info');
    await fs.mkdir(infoDir, { recursive: true });
    await fs.appendFile(
      path.join(infoDir, 'exclude'),
      `\n# Lattice-managed — do not commit\n${patterns.join('\n')}\n`,
      'utf8',
    );
  } catch (err) {
    // Non-fatal: the merge path already handles the shelve-and-restore
    // fallback; this is belt-and-suspenders prevention only.
    console.warn('[worktree] could not write local exclude file:', err);
  }
}

// Claude hook config — Stop hook posts back so the task moves to QA.
// Written into <worktree>/.claude/settings.local.json so it's scoped to
// just that worktree's Claude session.
//
// Exported as `renderStopHookJson` so the validation/repair path in the
// merge route can rebuild the file from the same template Lattice uses
// at setup time.
export function renderStopHookJson(taskId: string, backendOrigin: string): string {
  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${taskId}/complete`,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(hookConfig, null, 2);
}

async function installStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  const claudeDir = path.join(worktreePath, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.local.json');
  const expected = renderStopHookJson(taskId, backendOrigin);
  // Skip rewrite if the file already matches — keeps `git status` clean
  // when this worktree is reconciled and recreated against the same task.
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (existing === expected) return;
  } catch {
    /* file absent — fall through to write */
  }
  await fs.writeFile(file, expected, 'utf8');
}

// Append `.claude/settings.local.json` to the repo's root .gitignore if
// it isn't already covered. Idempotent: scans the existing file for
// either the literal entry or any line that would match it via gitignore
// pattern semantics. Bails silently if the project has no .gitignore
// (creating one would surprise the user); the worktree-local exclude
// still protects merges in that case.
const LATTICE_GITIGNORE_MARKER = '# lattice-managed (do not remove)';

export async function ensureLatticeGitignore(repoRoot: string): Promise<void> {
  const ignoreFile = path.join(repoRoot, '.gitignore');
  let existing: string;
  try {
    existing = await fs.readFile(ignoreFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn('[worktree] could not read .gitignore:', err);
    return;
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = LATTICE_GITIGNORE_ENTRIES.filter(
    (entry) => !lines.some((l) => l === entry || l === `/${entry}`),
  );
  if (missing.length === 0) return;
  const trailingNewline = existing.endsWith('\n') ? '' : '\n';
  const block =
    `${trailingNewline}\n${LATTICE_GITIGNORE_MARKER}\n${missing.join('\n')}\n`;
  try {
    await fs.appendFile(ignoreFile, block, 'utf8');
    console.log(
      `[worktree] appended ${missing.length} entry(ies) to ${ignoreFile}`,
    );
  } catch (err) {
    console.warn('[worktree] could not append to .gitignore:', err);
  }
}

// `git rm --cached` any Lattice-owned file that's still tracked in `repoRoot`,
// then commit the cleanup so it propagates when branches merge. Files stay
// on disk (rm --cached only touches the index). Idempotent: skips files
// that aren't tracked, and skips the commit if the index is unchanged.
//
// Called at:
//   - setupTaskWorktree (per-worktree create) — heals projects on first use
//   - startMergeRun (pre-flight)              — heals before main absorbs branches
//   - /api/tasks/:id/merge (manual merge)     — heals before a one-off merge
//
// Aborts (no-op) if the working tree has uncommitted changes — a commit
// here would entangle Lattice's cleanup with whatever the user is editing.
// The auto-resolve path at merge time still handles the conflict case.
export async function untrackOwnedFilesInRepo(repoRoot: string): Promise<void> {
  const tracked: string[] = [];
  for (const f of LATTICE_OWNED_FILE_PATHS) {
    const ls = await exec('git', ['ls-files', '--error-unmatch', f], repoRoot);
    if (ls.code === 0 && ls.stdout.trim()) tracked.push(f);
  }
  if (tracked.length === 0) return;

  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0) {
    console.warn(`[worktree] untrack: git status failed in ${repoRoot}`);
    return;
  }
  // Tolerate the working tree containing only Lattice-owned files (e.g. a
  // freshly-installed Stop hook). Anything else means real user state we
  // shouldn't bundle into a Lattice-auto commit.
  const dirtyOther = status.stdout
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !(LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(p));
  if (dirtyOther.length > 0) {
    console.log(
      `[worktree] skipping untrack of [${tracked.join(', ')}] in ${repoRoot} ` +
        `— working tree has unrelated changes (${dirtyOther.slice(0, 3).join(', ')}${dirtyOther.length > 3 ? ', …' : ''})`,
    );
    return;
  }

  const rm = await exec(
    'git',
    ['rm', '--cached', '--quiet', ...tracked],
    repoRoot,
  );
  if (rm.code !== 0) {
    console.warn(
      `[worktree] git rm --cached failed in ${repoRoot}: ${rm.stderr.trim()}`,
    );
    return;
  }
  const commit = await exec(
    'git',
    [
      'commit',
      '-m',
      `Untrack Lattice-managed files [lattice-auto]\n\n${tracked.map((f) => `- ${f}`).join('\n')}`,
    ],
    repoRoot,
  );
  if (commit.code !== 0) {
    // No commit usually means the index ended up unchanged (race with
    // another process). Reset the index to keep state coherent.
    console.warn(
      `[worktree] commit after rm --cached failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    );
    await exec('git', ['reset', 'HEAD', '--', ...tracked], repoRoot);
    return;
  }
  console.log(
    `[worktree] untracked Lattice-owned file(s) from ${repoRoot}: ${tracked.join(', ')}`,
  );
}
