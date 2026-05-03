// Markdown writers for the various instructions files Lattice drops into
// worktrees / repo roots:
//   - LATTICE_TASK.md         — initial task brief written into a fresh worktree
//   - MERGE_INSTRUCTIONS.md   — written into a worktree after a merge conflict
//   - STASH_CONFLICT_*.md     — written into the main repo after a stash-pop conflict
//
// Keeping the prose here in one place makes it easy to tweak the
// resolver-Claude prompts without touching merge logic.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../tasks.js';

export function renderTaskMarkdown(task: Task): string {
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
