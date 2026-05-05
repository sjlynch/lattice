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
  const slug = slugify(task.title);
  const shortId = task.id.slice(-6);
  const branchName = `lattice/${slug}-${shortId}`;
  const worktreesDir = path.join(repoRoot, '.lattice', 'worktrees');
  await fs.mkdir(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, `${slug}-${shortId}`);

  await reconcileStaleState(repoRoot, branchName, worktreePath);

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

  const taskFile = path.join(worktreePath, 'LATTICE_TASK.md');
  await fs.writeFile(taskFile, renderTaskMarkdown(task, backendOrigin), 'utf8');

  await installStopHook(worktreePath, task.id, backendOrigin);

  return { worktreePath, branch: branchName, taskFile };
}

// Branch names are deterministic from (slug, shortId), so a leftover
// branch/worktree from before will collide with `git worktree add -b`.
// Run = fresh start; the explicit Resume path is the one that
// preserves prior progress.
async function reconcileStaleState(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
): Promise<void> {
  const branchExists =
    (
      await exec(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        repoRoot,
      )
    ).code === 0;
  const targetDirExists = await worktreeExists(worktreePath);

  if (!branchExists && !targetDirExists) return;

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

// Claude hook config — Stop hook posts back so the task moves to QA.
// Written into <worktree>/.claude/settings.local.json so it's scoped to
// just that worktree's Claude session.
async function installStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
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
              command: `curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${taskId}/complete`,
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
}
