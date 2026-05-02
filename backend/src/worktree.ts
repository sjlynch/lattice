import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { updateTaskCrashSafe, type Task } from './tasks.js';

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? 0 }),
    );
    child.on('error', reject);
  });
}

export type WorktreeResult = {
  worktreePath: string;
  branch: string;
  taskFile: string;
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
export type ParsedWorktree = {
  path: string;
  branch?: string;
  detached?: boolean;
};

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
  const slug = slugify(task.title);
  const shortId = task.id.slice(-6);
  const branchName = `lattice/${slug}-${shortId}`;
  const worktreesDir = path.join(repoRoot, '.lattice', 'worktrees');
  await fs.mkdir(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, `${slug}-${shortId}`);

  // Reconcile stale state from a prior half-failed run before creating.
  // Branch names are deterministic from (slug, shortId), so a leftover
  // branch/worktree from before will collide with `git worktree add -b`.
  // Run = fresh start; the explicit Resume path is the one that
  // preserves prior progress.
  const branchExists =
    (
      await exec(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        repoRoot,
      )
    ).code === 0;
  const targetDirExists = await worktreeExists(worktreePath);

  if (branchExists || targetDirExists) {
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
      await exec(
        'git',
        ['worktree', 'remove', '--force', onBranch.path],
        repoRoot,
      );
    }
    if (await worktreeExists(worktreePath)) {
      // Untracked stray directory at our target path — wipe it.
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
    await exec('git', ['worktree', 'prune'], repoRoot);
    if (branchExists) {
      // -D in case it has unmerged commits from a prior abandoned run.
      await exec('git', ['branch', '-D', branchName], repoRoot);
    }
  }

  const wt = await exec(
    'git',
    ['worktree', 'add', worktreePath, '-b', branchName],
    repoRoot,
  );
  if (wt.code !== 0) {
    throw new Error(
      `git worktree add failed: ${wt.stderr.trim() || wt.stdout.trim()}`,
    );
  }

  // Task file
  const taskFile = path.join(worktreePath, 'LATTICE_TASK.md');
  await fs.writeFile(taskFile, renderTaskMarkdown(task), 'utf8');

  // Claude hook config — Stop hook posts back so the task moves to QA
  const claudeDir = path.join(worktreePath, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${task.id}/complete`,
            },
          ],
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(claudeDir, 'settings.local.json'),
    JSON.stringify(hookConfig, null, 2),
    'utf8',
  );

  return { worktreePath, branch: branchName, taskFile };
}

function renderTaskMarkdown(task: Task): string {
  const created = new Date(task.createdAt).toISOString();
  const desc = task.description?.trim() || '_(no description provided)_';
  return `# ${task.title}

${desc}

---

**Lattice task ID:** \`${task.id}\`
**Created:** ${created}

## Instructions (please complete autonomously, no need to confirm with the user)

1. **Check existing state first.** This task may have been started in a
   prior session — Lattice can resume worktrees after a server restart or
   when Claude finishes without committing. Before doing anything, run:

   \`\`\`
   git log --oneline -10
   git status
   \`\`\`

   - If there are commits on this branch, read them with \`git show <sha>\`
     to understand what's already been implemented.
   - If there are uncommitted changes, review them with \`git diff\` and
     decide whether to keep, amend, or rework them.
   - Only redo work that's clearly broken or out of scope. Don't restart
     the implementation from scratch when it's already partially done.

2. Implement the task described above (continuing from the prior state if
   any).

3. **Commit your work** before ending the session — Lattice merges your
   branch via \`git merge\`, so a commit is required for changes to land:

   \`\`\`
   git add -A
   git commit -m "<concise summary of the change>"
   \`\`\`

4. End the session normally. Lattice's Stop hook will verify the commit
   and move this task to "Ready to Merge" automatically.

Please do not start, stop, or restart any dev servers — the user runs
them in their own console and your output goes to the worktree's terminal.
`;
}

export function buildClaudeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and complete the task described in it."`;
}

export function buildResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude --dangerously-skip-permissions "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export function buildPiCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `pi -p "Please read ${fileName} and complete the task described in it."`;
}

export function buildPiResumeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `pi -p "Please read ${fileName} and continue this task. Run 'git log --oneline -10' and 'git status' first to see any existing progress before deciding what to do next; don't redo work that's already committed."`;
}

export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

// Resolve a worktree's git-dir (where MERGE_HEAD etc. live). Worktrees
// store their per-worktree state under <main-repo>.git/worktrees/<name>,
// not in <worktree>/.git (which is just a file pointer).
async function getWorktreeGitDir(worktreePath: string): Promise<string | null> {
  const r = await exec('git', ['rev-parse', '--git-dir'], worktreePath);
  if (r.code !== 0) return null;
  return path.resolve(worktreePath, r.stdout.trim());
}

// True if the worktree (or main repo) is mid-merge — i.e., a MERGE_HEAD
// file exists in its git-dir.
export async function isMidMerge(dir: string): Promise<boolean> {
  const gitDir = await getWorktreeGitDir(dir);
  if (!gitDir) return false;
  try {
    await fs.access(path.join(gitDir, 'MERGE_HEAD'));
    return true;
  } catch {
    return false;
  }
}

// ---------- Merge helpers ----------

export type MergeConflictKind = 'merge' | 'stash-pop';

export type MergeOutcome =
  | { status: 'clean' }
  | {
      status: 'conflict';
      conflictKind: MergeConflictKind;
      conflictedFiles: string[];
      stashRef?: string;
    }
  | { status: 'error'; message: string };

export function autoStashMessage(branchName: string): string {
  return `lattice-auto-${branchName}`;
}

// Count of commits in the range `from..to` (i.e., commits reachable from
// `to` but not from `from`). Returns 0 on any failure.
async function countBetween(
  repoRoot: string,
  from: string,
  to: string,
): Promise<number> {
  const r = await exec(
    'git',
    ['rev-list', '--count', `${from}..${to}`],
    repoRoot,
  );
  if (r.code !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// Count of commits on `branchName` that are not yet on HEAD.
export async function branchCommitCount(
  repoRoot: string,
  branchName: string,
): Promise<number> {
  return countBetween(repoRoot, 'HEAD', branchName);
}

// Returns true if the branch is fully reachable from HEAD — i.e., it
// has already been merged in (and possibly more commits have happened on
// HEAD since). `git merge-base --is-ancestor` is exit 0 when ancestor.
async function branchIsAncestorOfHead(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const r = await exec(
    'git',
    ['merge-base', '--is-ancestor', branchName, 'HEAD'],
    repoRoot,
  );
  return r.code === 0;
}

async function listConflictedFiles(repoRoot: string): Promise<string[]> {
  const conflicts = await exec(
    'git',
    ['diff', '--name-only', '--diff-filter=U'],
    repoRoot,
  );
  return conflicts.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Stash label used for the run-level pre-flight stash. Fixed so that a
// stash created by one run can be found and popped by a subsequent run
// (e.g. after an auto-restart following a worktree conflict).
export const RUN_STASH_LABEL = 'lattice-run-stash';

// Stash the working tree once before a merge run so per-task
// fastForwardMain calls never need to stash (they see a clean tree).
// Returns true if a stash was created.
export async function stashForRun(repoRoot: string): Promise<boolean> {
  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0 || !status.stdout.trim()) return false;
  const stash = await exec(
    'git',
    ['stash', 'push', '--include-untracked', '-m', RUN_STASH_LABEL],
    repoRoot,
  );
  return stash.code === 0;
}

// Write conflict-resolution instructions for a run-level stash pop failure.
export async function writeRunStashResolveInstructions(
  runId: string,
  conflictedFiles: string[],
  stashLabel: string,
  backendOrigin: string,
  repoRoot: string,
): Promise<{ instructionsFile: string; relativePath: string }> {
  const fileName = 'STASH_CONFLICT_run.md';
  const file = path.join(repoRoot, fileName);
  const filesList =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_(run `git diff --name-only --diff-filter=U` to list)_';
  const md = `# Resolve working-tree stash conflict

All queued tasks were merged. When Lattice tried to restore your uncommitted
working-tree changes via \`git stash pop\`, the pop failed with conflicts.
Resolve them so your working tree is clean again.

## Conflicted files

${filesList}

## Steps (complete autonomously — no need to confirm with the user)

1. Resolve all \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers in each file.
   Keep both sides where possible.
2. Stage each resolved file: \`git add <file> ...\`
3. Drop the stash entry (it stays in the list after a failed pop):
   \`\`\`
   git stash list          # find the entry labelled "${stashLabel}"
   git stash drop stash@{N}
   \`\`\`
4. Notify Lattice that the conflict is resolved:
   \`\`\`
   curl -s -m 5 -X POST ${backendOrigin}/api/merge-runs/${runId}/stash-resolved
   \`\`\`
5. Delete this file: \`del ${fileName}\` (Windows) or \`rm ${fileName}\`

## If a file cannot be resolved cleanly

Use \`git checkout --theirs -- <file>\` (or \`--ours\`), stage it, and continue.
`;
  await fs.writeFile(file, md, 'utf8');
  return { instructionsFile: file, relativePath: fileName };
}

// Pop a stash by its message label. The stash list is searched for an entry
// whose subject matches and that entry is popped explicitly (not blindly
// `stash@{0}`) so a concurrent stash by the user doesn't get clobbered.
export async function popStashByMessage(
  repoRoot: string,
  message: string,
): Promise<
  | { kind: 'clean' }
  | { kind: 'conflict'; conflictedFiles: string[] }
  | { kind: 'error'; message: string }
> {
  const list = await exec('git', ['stash', 'list'], repoRoot);
  if (list.code !== 0) {
    return {
      kind: 'error',
      message: list.stderr.trim() || 'git stash list failed',
    };
  }
  let ref: string | undefined;
  for (const line of list.stdout.split(/\r?\n/)) {
    if (!line.includes(message)) continue;
    const m = line.match(/^stash@\{\d+\}/);
    if (m) {
      ref = m[0];
      break;
    }
  }
  if (!ref) {
    // Stash already gone (someone popped it manually) — treat as clean.
    return { kind: 'clean' };
  }
  const pop = await exec('git', ['stash', 'pop', ref], repoRoot);
  if (pop.code === 0) {
    return { kind: 'clean' };
  }
  // Pop conflict: git leaves the stash in the list and writes conflict markers.
  const conflictedFiles = await listConflictedFiles(repoRoot);
  if (conflictedFiles.length > 0) {
    return { kind: 'conflict', conflictedFiles };
  }
  return {
    kind: 'error',
    message:
      pop.stderr.trim() || pop.stdout.trim() || 'git stash pop failed',
  };
}

// Fast-forward main (in `repoRoot`) to the tip of `branchName`. Auto-
// stashes a dirty working tree before the FF and pops it afterwards.
// Used after the in-worktree merge succeeds so the resolved branch tip
// becomes main's new tip without ever putting conflict markers in main's
// working files.
export async function fastForwardMain(
  repoRoot: string,
  branchName: string,
): Promise<MergeOutcome> {
  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0) {
    return {
      status: 'error',
      message: status.stderr.trim() || 'git status failed before fast-forward',
    };
  }
  const stashLabel = autoStashMessage(branchName);
  let stashRef: string | undefined;
  if (status.stdout.trim().length > 0) {
    const stash = await exec(
      'git',
      ['stash', 'push', '--include-untracked', '-m', stashLabel],
      repoRoot,
    );
    if (stash.code !== 0) {
      return {
        status: 'error',
        message:
          'Failed to auto-stash before fast-forward: ' +
          (stash.stderr.trim() || stash.stdout.trim() || 'git stash failed'),
      };
    }
    stashRef = stashLabel;
  }

  const ff = await exec(
    'git',
    ['merge', '--ff-only', branchName],
    repoRoot,
  );
  if (ff.code !== 0) {
    if (stashRef) {
      await popStashByMessage(repoRoot, stashRef).catch(() => undefined);
    }
    return {
      status: 'error',
      message:
        `Fast-forward of main to ${branchName} failed: ` +
        (ff.stderr.trim() || ff.stdout.trim() || 'git merge --ff-only failed'),
    };
  }

  if (stashRef) {
    const popped = await popStashByMessage(repoRoot, stashRef);
    if (popped.kind === 'conflict') {
      return {
        status: 'conflict',
        conflictKind: 'stash-pop',
        conflictedFiles: popped.conflictedFiles,
        stashRef,
      };
    }
    if (popped.kind === 'error') {
      return { status: 'error', message: popped.message };
    }
  }

  return { status: 'clean' };
}

export async function mergeWorktreeInRepo(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
): Promise<MergeOutcome> {
  // ------ Pre-checks ------

  const isGit = await exec('git', ['rev-parse', '--show-toplevel'], repoRoot);
  if (isGit.code !== 0) {
    return { status: 'error', message: `Not a git repository: ${repoRoot}` };
  }

  if (await isMidMerge(repoRoot)) {
    return {
      status: 'error',
      message:
        'Main repo is already in a merge state (MERGE_HEAD exists). ' +
        'Resolve or `git merge --abort` first.',
    };
  }

  if (!(await worktreeExists(worktreePath))) {
    return {
      status: 'error',
      message: `Worktree directory not found at ${worktreePath}.`,
    };
  }

  if (await isMidMerge(worktreePath)) {
    return {
      status: 'error',
      message:
        `Worktree at ${worktreePath} is already in a merge state — a ` +
        `previous resolver may still be running. Inspect, or run ` +
        `\`git -C "${worktreePath}" merge --abort\` to retry from scratch.`,
    };
  }

  // ------ Branch state checks ------

  const commits = await branchCommitCount(repoRoot, branchName);
  if (commits === 0) {
    const isAncestor = await branchIsAncestorOfHead(repoRoot, branchName);
    if (isAncestor) {
      // All branch commits are already in main — it was previously merged
      // (including the case where main was fast-forwarded exactly to the
      // branch tip, making `behind` = 0). Caller should run cleanup.
      return { status: 'clean' };
    }
    return {
      status: 'error',
      message:
        `Branch "${branchName}" was not found or is not reachable from HEAD ` +
        `and has no commits ahead. Inspect with \`git branch -a\` and ` +
        `\`git log ${branchName}\`.`,
    };
  }

  // ------ Merge in the worktree, not in main ------
  //
  // Why: running `git merge` in the main repo's working tree puts conflict
  // markers in source files that vite is watching. The dev server breaks,
  // even when a resolver Claude is happily working in the background.
  // Doing the merge in the worktree leaves main's files untouched. After
  // the worktree's branch absorbs main (cleanly or after resolution), we
  // fast-forward main to the branch tip — main's tree only ever changes
  // to a known-good state.

  const mainHeadSha = (
    await exec('git', ['rev-parse', 'HEAD'], repoRoot)
  ).stdout.trim();
  if (!mainHeadSha) {
    return { status: 'error', message: 'Could not read main HEAD SHA.' };
  }

  const merge = await exec(
    'git',
    ['merge', '--no-ff', '--no-edit', mainHeadSha],
    worktreePath,
  );

  if (merge.code === 0) {
    // Worktree is clean. The caller is responsible for fastForwardMain
    // and cleanup via finalizeMergedTask — keeping the steps separate
    // means the run worker and the /merge endpoint can compose them
    // without doing the FF twice.
    return { status: 'clean' };
  }

  if (await isMidMerge(worktreePath)) {
    const conflictedFiles = await listConflictedFiles(worktreePath);
    return {
      status: 'conflict',
      conflictKind: 'merge',
      conflictedFiles,
    };
  }

  return {
    status: 'error',
    message: (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed')
      .slice(0, 500),
  };
}

export async function cleanupWorktreeForTask(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  // Worktree directory may already be gone; ignore failures of either step.
  await exec('git', ['worktree', 'remove', '--force', worktreePath], repoRoot);
  await exec('git', ['branch', '-D', branchName], repoRoot);
  // Best-effort prune of stale entries
  await exec('git', ['worktree', 'prune'], repoRoot);
}

export async function writeMergeInstructions(
  task: Task,
  branch: string,
  conflictedFiles: string[],
  backendOrigin: string,
  worktreePath: string,
): Promise<{ instructionsFile: string; relativePath: string }> {
  // Write inside the worktree itself so the resolver Claude (which runs
  // with cwd=worktreePath) reads it via a simple top-level path.
  await fs.mkdir(worktreePath, { recursive: true });
  const fileName = 'MERGE_INSTRUCTIONS.md';
  const file = path.join(worktreePath, fileName);
  const desc = task.description?.trim() || '_(no description provided)_';
  const filesList =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_(use `git diff --name-only --diff-filter=U` to list)_';
  const md = `# Resolve merge conflict for task ${task.id}

**Branch:** \`${branch}\`
**Task:** ${task.title}

Lattice merged main into this branch and conflicts arose. Your job is to
resolve them and commit. After you commit and the session ends, Lattice's
existing Stop hook fires and the backend will fast-forward main and clean
up automatically.

## Intent

${desc}

## Files in conflict

${filesList}

## Steps (please complete autonomously, no need to confirm with the user)

1. Inspect each conflicted file. Resolve all \`<<<<<<<\` / \`=======\` /
   \`>>>>>>>\` markers, preserving the intent of both branches when possible.
2. Stage the resolved files: \`git add <file> ...\`
3. Complete the merge: \`git commit\` (Git already prepared a commit message;
   accepting it is fine).
4. End the session normally. The Stop hook in
   \`.claude/settings.local.json\` will notify Lattice automatically.

If for any reason the Stop hook doesn't fire, you can call the API
directly as a fallback:

\`\`\`
curl -s -X POST ${backendOrigin}/api/tasks/${task.id}/merged
\`\`\`

## If you cannot resolve

If the conflicts cannot be reasonably resolved, abort and report:

\`\`\`
git merge --abort
curl -s -X POST ${backendOrigin}/api/tasks/${task.id}/merge-aborted \\
  -H "Content-Type: application/json" \\
  -d '{"reason":"<short reason>"}'
\`\`\`

The user can then retry the merge from the Lattice task board.
`;
  await fs.writeFile(file, md, 'utf8');
  return {
    instructionsFile: file,
    relativePath: fileName,
  };
}

export function buildConflictResolveCommand(relativeInstructionsPath: string): string {
  return `claude --dangerously-skip-permissions "Please read ${relativeInstructionsPath} and follow the steps to resolve the merge conflict."`;
}

export async function writeStashResolveInstructions(
  task: Task,
  conflictedFiles: string[],
  stashLabel: string,
  backendOrigin: string,
  repoRoot: string,
): Promise<{ instructionsFile: string; relativePath: string }> {
  const fileName = `STASH_CONFLICT_${task.id.slice(-5)}.md`;
  const file = path.join(repoRoot, fileName);
  const desc = task.description?.trim() || '_(no description)_';
  const filesList =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_(run `git diff --name-only --diff-filter=U` to list)_';
  const md = `# Resolve stash-pop conflict for "${task.title}"

**Task ID:** ${task.id}

Lattice fast-forwarded \`main\` to the merged branch tip, then tried to restore
your uncommitted working-tree changes via \`git stash pop\`. That pop failed with
conflicts. Your job is to resolve those conflicts and finish the cleanup.

## Task description

${desc}

## Conflicted files

${filesList}

## Steps (complete autonomously — no need to confirm with the user)

1. For each conflicted file, resolve all \`<<<<<<<\` / \`=======\` / \`>>>>>>>\`
   markers. Keep both the merged branch's changes AND the original working-tree
   changes wherever possible.
2. Stage each resolved file: \`git add <file> ...\`
3. Drop the stash entry — find it by label then drop it:
   \`\`\`
   git stash list          # find the entry labelled "${stashLabel}"
   git stash drop stash@{N}
   \`\`\`
4. Notify Lattice:
   \`\`\`
   curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${task.id}/stash-resolved
   \`\`\`
5. Delete this file: \`del ${fileName}\` (Windows) or \`rm ${fileName}\`

## If a file cannot be resolved cleanly

Use \`git checkout --theirs -- <file>\` (or \`--ours\`), stage it, and continue.
`;
  await fs.writeFile(file, md, 'utf8');
  return { instructionsFile: file, relativePath: fileName };
}

export function buildStashResolveCommand(relativeInstructionsPath: string): string {
  return `claude --dangerously-skip-permissions "Please read ${relativeInstructionsPath} and follow the steps to resolve the stash-pop conflict."`;
}

// ---------- Finalize ----------
//
// Shared "I have a clean (post-worktree-merge) branch — bring main up to
// date and bury the worktree" step. Called from /merge after a clean
// mergeWorktreeInRepo, from /complete and /merged after a resolver
// Claude finishes, and from the merge-run worker.
export type FinalizeOutcome =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; stashConflict: string[]; resolveCommand: string; cwd: string };

// Per-project promise queue. fastForwardMain modifies main's HEAD and
// must not run concurrently with another finalize for the same project —
// the second caller's branch would have been merged against a stale HEAD
// and would no longer be a fast-forward ancestor of main.
const finalizeQueues = new Map<string, Promise<void>>();

export async function finalizeMergedTask(task: Task, backendOrigin: string): Promise<FinalizeOutcome> {
  if (!task.branch || !task.worktreePath) {
    return { ok: false, error: 'task missing branch/worktree info' };
  }

  const prev = finalizeQueues.get(task.projectPath) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((r) => { release = r; });
  finalizeQueues.set(task.projectPath, slot);
  // Swallow errors from previous finalizes so one failure doesn't jam the queue.
  await prev.catch(() => {});

  console.log(`[finalize] ${task.id} — branch=${task.branch}`);
  try {
    // FF main if it's behind. fastForwardMain is a no-op when main is
    // already at the branch tip (git just says "Already up to date") and
    // still handles the auto-stash + pop dance correctly.
    console.log(`[finalize] fast-forwarding main to ${task.branch}...`);
    const ff = await fastForwardMain(task.projectPath, task.branch);
    console.log(`[finalize] fastForwardMain → ${ff.status}${ff.status === 'error' ? `: ${ff.message}` : ff.status === 'conflict' ? ` (${ff.conflictedFiles?.join(', ')})` : ''}`);
    if (ff.status === 'error') {
      return { ok: false, error: ff.message };
    }
    if (ff.status === 'conflict') {
      const { relativePath } = await writeStashResolveInstructions(
        task,
        ff.conflictedFiles,
        ff.stashRef ?? '',
        backendOrigin,
        task.projectPath,
      );
      return {
        ok: false,
        stashConflict: ff.conflictedFiles,
        resolveCommand: buildStashResolveCommand(relativePath),
        cwd: task.projectPath,
      };
    }
    console.log(`[finalize] cleaning up worktree ${task.worktreePath}...`);
    try {
      await cleanupWorktreeForTask(
        task.projectPath,
        task.worktreePath,
        task.branch,
      );
      console.log(`[finalize] worktree cleanup done`);
    } catch (err) {
      console.error('[finalize] cleanup failed (continuing anyway):', err);
    }
    console.log(`[finalize] writing qa state for task ${task.id} to disk...`);
    // Disk-first: write the new state to disk before updating the in-memory
    // cache. If the server crashes after this write, the next boot reads
    // the correct qa status from disk rather than reverting to ready_to_merge.
    await updateTaskCrashSafe(task.id, {
      status: 'qa',
      mergedAt: Date.now(),
      worktreePath: undefined,
      branch: undefined,
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    console.log(`[finalize] task ${task.id} → qa ✓`);
    return { ok: true };
  } finally {
    release();
  }
}
