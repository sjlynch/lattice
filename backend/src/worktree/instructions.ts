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
import { renderStopHookJson } from './setup.js';

// Validate (and repair if needed) the worktree's Stop-hook config.
//
// The resolver Claude reads .claude/settings.local.json at startup. If
// merge conflict markers landed inside the JSON, Claude's parser fails
// with a "Settings Error" prompt before the user prompt is processed —
// the resolver can't even read the merge instructions. Layer 2 auto-
// resolve should mean this is always clean by the time we get here, but
// a stale state from before this code shipped (or a hand-edit) could
// still leave the file broken. Repair from Lattice's known-good template
// — the worktree's task ID is the correct Stop-hook target either way.
async function ensureValidStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  const file = path.join(worktreePath, '.claude', 'settings.local.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[instructions] could not read ${file}:`, err);
      return;
    }
    // File missing — the resolver Claude will just have no Stop hook
    // (the resolver's `/merged` and `/merge-aborted` callbacks still
    // work). Recreate from the template so the auto-callback works.
    raw = '';
  }
  let valid = false;
  if (raw) {
    try {
      JSON.parse(raw);
      valid = true;
    } catch {
      valid = false;
    }
  }
  if (valid) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, renderStopHookJson(taskId, backendOrigin), 'utf8');
  console.warn(
    `[instructions] repaired malformed ${file} for task ${taskId} ` +
      `(would have broken Claude bootstrap)`,
  );
}

// `harness` controls a couple of pieces. Claude (the default) ends the
// session and its Stop hook in `.claude/settings.local.json` POSTs
// `/complete`. Pi and Codex have no command-hook mechanism, so the model
// itself must run the whole tail end of the checklist — commit, PATCH the
// description, POST `/complete` — without stopping to ask. (For Pi a
// worktree-local extension, installPiCompletionExtension, also POSTs
// `/complete` on session exit as a backstop, but the model should not rely
// on it.) The non-Claude variant therefore gets an explicit "this is an
// autonomous session, finish everything" preamble and a stronger final step.
export function renderTaskMarkdown(
  task: Task,
  backendOrigin: string,
  harness: 'claude' | 'pi' | 'codex' = 'claude',
): string {
  const created = new Date(task.createdAt).toISOString();
  const desc = task.description?.trim() || '_(no description provided)_';
  const autonomyPreamble =
    harness === 'claude'
      ? ''
      : `> **This is an autonomous worktree session — there is no user watching to
> confirm with, and the turn will not be picked up again.** Work through
> the whole checklist below to the end in this same session, without pausing
> to ask for permission or approval. That includes the wrap-up: commit your
> work, update the task description, and POST the \`/complete\` callback —
> these are part of the task, not optional follow-ups. Stopping after "I
> implemented it" — without committing and calling \`/complete\` — leaves
> the task stuck in "In Progress" and the work invisible to Lattice. Don't
> end your turn until you've run the \`/complete\` curl (or deliberately
> determined there's nothing to commit, in which case say so).

`;
  const finalStep =
    harness === 'claude'
      ? `5. End the session normally. Lattice's Stop hook will verify the commit and move this task to "Ready to Merge" automatically.`
      : `5. **Final step — tell Lattice you're done (do not skip this).** Lattice
   can't auto-detect this session ending, so the *last thing you do* must
   be:

   \`\`\`
   curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${task.id}/complete
   \`\`\`

   This is what moves the task to "Ready to Merge". Run it yourself — don't
   ask the user to, and don't end your turn before running it. The only time
   you skip it is if there is genuinely nothing committed on this branch (in
   which case Lattice leaves the task In Progress so it can be resumed);
   even then, say so explicitly rather than just stopping.`;
  return `# ${task.title}

${desc}

---

**Lattice task ID:** \`${task.id}\`
**Created:** ${created}

## Instructions (please complete autonomously, no need to confirm with the user)

${autonomyPreamble}1. **Check existing state first.** This task may have been started in a
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

4. **Update the Lattice task with a short summary of the changes** so the
   task board reflects what was actually done once it lands in
   "Ready to Merge". PATCH the task description:

   \`\`\`
   curl -s -X PATCH ${backendOrigin}/api/tasks/${task.id} \\
     -H "Content-Type: application/json" \\
     -d '{"description":"<1-3 bullet summary of what changed>"}'
   \`\`\`

   Keep it concise (1-3 bullet points). This replaces the original
   description; the original task intent is preserved in this
   \`LATTICE_TASK.md\` file and in the branch's git history.

${finalStep}

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
  // Last-line-of-defense: make sure the resolver Claude's settings.json
  // is parseable before we tell the UI to spawn it.
  await ensureValidStopHook(worktreePath, task.id, backendOrigin);
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
