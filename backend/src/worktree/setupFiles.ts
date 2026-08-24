import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from '../tasks.js';
import type { AgentHarness } from '../harnesses.js';
import type { DeadCodeSummary } from '../deadCode.js';
import { seedClaudeTrust } from '../claudeTrust.js';
import { renderTaskMarkdown } from './instructions.js';
import { resolveInstructionTemplate } from '../instructionTemplates.js';
import { LATTICE_EXCLUDE_PATTERNS } from './managedFiles.js';
import { installPiSubagentsShim } from '../piSubagents.js';
import {
  installCodexCompletionHook,
  installPiCompletionExtension,
  installStopHook,
  writeWorktreeExclude,
} from './stopHook.js';

export async function writePostAddWorktreeFiles(
  worktreePath: string,
  task: Task,
  backendOrigin: string,
  harness: AgentHarness,
  envNotes: string[],
  deadCode: DeadCodeSummary | null,
): Promise<string> {
  // Home-scoped worktrees sit outside the project's `.git`, so Claude treats
  // each fresh worktree as its own untrusted project root. Pre-accept the
  // trust dialog so the Run flow stays one-click. Always seeded — a Pi/Codex
  // task that later hits a merge conflict spawns a Claude resolver in here.
  await seedClaudeTrust(worktreePath);

  const taskFile = path.join(worktreePath, 'LATTICE_TASK.md');
  const taskTemplate = await resolveInstructionTemplate(task.projectPath, 'task');
  await fs.writeFile(
    taskFile,
    renderTaskMarkdown(task, backendOrigin, harness, envNotes, deadCode, taskTemplate),
    'utf8',
  );
  // The Claude Stop hook is installed for every worktree regardless of run
  // harness: a Pi/Codex task that later hits a merge conflict spawns a
  // *Claude* resolver, which relies on this hook to call `/complete`.
  await installStopHook(worktreePath, task.id, backendOrigin);
  // Always install the Pi completion extension too (defence-in-depth):
  // historically gated on harness === 'pi', but installing unconditionally
  // means a mid-task harness switch (resume under a different harness,
  // operator opening a Pi prompt in the worktree) still has the backstop.
  // Pi auto-loads `.pi/extensions/*.ts`; nothing else sees the file. The
  // file is excluded from `git status` via writeWorktreeExclude below.
  await installPiCompletionExtension(worktreePath, task.id, backendOrigin);
  // Codex Stop hook (the Codex analogue). `if-absent`: never clobber a
  // `.codex/hooks.json` the repo itself tracks — a Codex run then falls back to
  // the model's explicit `/complete` curl (as it did before this backstop
  // existed). The one exception is a file we can positively identify as
  // LATTICE-generated (see isLatticeGeneratedCodexHooks): once one of those gets
  // committed on main it is checked out into every fresh worktree carrying
  // ANOTHER task's completion URL, so preserving it would report the wrong task
  // finished. Written file is excluded from `git status` below.
  const codexHookInstalled = await installCodexCompletionHook(
    worktreePath,
    task.id,
    backendOrigin,
  );
  if (!codexHookInstalled) {
    console.warn(
      `[task-worktree] task ${task.id}: an existing .codex/hooks.json was left ` +
        `intact — relying on the model's explicit /complete curl for a Codex run`,
    );
  }
  // Drop the pi-subagents loader shim next to the completion extension so a Pi
  // task in this worktree gets sub-agents. No-op until the shared install has
  // resolved (graceful), and excluded from `git status` via LATTICE_EXCLUDE_PATTERNS.
  await installPiSubagentsShim({ dir: worktreePath });
  console.log(
    `[task-worktree] installed Claude+Pi+Codex backstops for task ${task.id} ` +
      `(active harness=${harness}, worktree=${worktreePath})`,
  );
  // Keep Lattice-managed files out of `git status` so Claude's `git add .`
  // never stages them. Writes to the worktree-local exclude (not the repo
  // .gitignore) so the project's tracked files are untouched.
  await writeWorktreeExclude(worktreePath, [...LATTICE_EXCLUDE_PATTERNS]);

  return taskFile;
}
