import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from './tasks.js';

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

1. Implement the task described above.
2. **Commit your work** before ending the session — Lattice merges your
   branch via \`git merge\`, so a commit is required for changes to land:

   \`\`\`
   git add -A
   git commit -m "<concise summary of the change>"
   \`\`\`

3. End the session normally. Lattice's Stop hook will verify the commit
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

export async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
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

// Count of commits on `branchName` that are not yet on HEAD of the repo
// at `repoRoot`. Returns 0 on any failure, which we treat as "nothing to
// merge" rather than surfacing a false positive.
export async function branchCommitCount(
  repoRoot: string,
  branchName: string,
): Promise<number> {
  const r = await exec(
    'git',
    ['rev-list', '--count', `HEAD..${branchName}`],
    repoRoot,
  );
  if (r.code !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
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

// Pop a stash by its message label. The stash list is searched for an entry
// whose subject matches and that entry is popped explicitly (not blindly
// `stash@{0}`) so a concurrent stash by the user doesn't get clobbered.
async function popStashByMessage(
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

export async function mergeWorktreeInRepo(
  repoRoot: string,
  branchName: string,
): Promise<MergeOutcome> {
  // Pre-checks
  const isGit = await exec('git', ['rev-parse', '--show-toplevel'], repoRoot);
  if (isGit.code !== 0) {
    return { status: 'error', message: `Not a git repository: ${repoRoot}` };
  }

  // Already mid-merge? Refuse — stashing wouldn't help here.
  const mergeHead = path.join(repoRoot, '.git', 'MERGE_HEAD');
  try {
    await fs.access(mergeHead);
    return {
      status: 'error',
      message:
        'Repository is already in a merge state (MERGE_HEAD exists). Resolve or `git merge --abort` first.',
    };
  } catch {
    /* good — no MERGE_HEAD */
  }

  // The branch must actually have commits to merge. If Claude finished
  // without committing, the worktree branch will be at the same SHA as
  // HEAD and `git merge` would silently report "Already up to date".
  // Surface that instead so the user knows where the regression is.
  const commits = await branchCommitCount(repoRoot, branchName);
  if (commits === 0) {
    return {
      status: 'error',
      message:
        `Branch "${branchName}" has no commits ahead of HEAD — nothing to merge. ` +
        `Claude may have finished without committing. Open the worktree, run ` +
        `\`git status\` / \`git log\` to inspect, commit any pending changes, ` +
        `and retry the merge.`,
    };
  }

  // If the working tree is dirty, auto-stash it under a deterministic label
  // so the merge can proceed and the user's in-flight edits stay recoverable
  // even if anything later fails.
  const status = await exec('git', ['status', '--porcelain'], repoRoot);
  if (status.code !== 0) {
    return {
      status: 'error',
      message: status.stderr.trim() || 'git status failed',
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
          'Failed to auto-stash working-tree changes: ' +
          (stash.stderr.trim() || stash.stdout.trim() || 'git stash failed'),
      };
    }
    stashRef = stashLabel;
  }

  // Attempt merge
  const merge = await exec(
    'git',
    ['merge', '--no-ff', '--no-edit', branchName],
    repoRoot,
  );

  if (merge.code !== 0) {
    // Conflict has MERGE_HEAD; anything else is a hard error.
    let isConflict = false;
    try {
      await fs.access(mergeHead);
      isConflict = true;
    } catch {
      /* not a conflict */
    }
    if (isConflict) {
      const conflictedFiles = await listConflictedFiles(repoRoot);
      // Stash stays in place; resolver Claude is told how to reconcile.
      return {
        status: 'conflict',
        conflictKind: 'merge',
        conflictedFiles,
        stashRef,
      };
    }
    // Hard error: try to pop the stash back so the user isn't stranded.
    if (stashRef) {
      await popStashByMessage(repoRoot, stashRef).catch(() => undefined);
    }
    return {
      status: 'error',
      message:
        (merge.stderr.trim() || merge.stdout.trim() || 'git merge failed').slice(
          0,
          500,
        ),
    };
  }

  // Merge succeeded. If we stashed, restore those edits now.
  if (stashRef) {
    const popped = await popStashByMessage(repoRoot, stashRef);
    if (popped.kind === 'conflict') {
      // Merge commit is on main; the conflicts are from the stash applying
      // on top. Resolver Claude commits the resolved stash as a follow-up.
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
): Promise<{ instructionsFile: string; relativePath: string }> {
  const dir = path.join(task.projectPath, '.lattice');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `merge-${task.id}.md`);
  const desc = task.description?.trim() || '_(no description provided)_';
  const filesList =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_(use `git diff --name-only --diff-filter=U` to list)_';
  const md = `# Resolve merge conflict for task ${task.id}

**Branch:** \`${branch}\`
**Task:** ${task.title}

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
4. Notify Lattice that the merge is complete:

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
    relativePath: path
      .relative(task.projectPath, file)
      .split(path.sep)
      .join('/'),
  };
}

export function buildConflictResolveCommand(relativeInstructionsPath: string): string {
  return `claude --dangerously-skip-permissions "Please read ${relativeInstructionsPath} and follow the steps to resolve the merge conflict."`;
}
