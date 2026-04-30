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
  const repoName = path.basename(repoRoot);
  const slug = slugify(task.title);
  const shortId = task.id.slice(-6);
  const branchName = `lattice/${slug}-${shortId}`;
  const worktreesDir = path.join(
    path.dirname(repoRoot),
    `${repoName}-worktrees`,
  );
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

## Instructions

Please implement the task described above. When you finish, ending the
session will trigger Lattice's Stop hook which automatically moves this task
to the QA column.
`;
}

export function buildClaudeCommand(taskFile: string): string {
  const fileName = path.basename(taskFile);
  return `claude "Please read ${fileName} and complete the task described in it."`;
}
