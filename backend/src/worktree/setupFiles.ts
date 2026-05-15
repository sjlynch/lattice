import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task } from '../tasks.js';
import type { AgentHarness } from '../harnesses.js';
import { ensureTrustedClaudeDir } from '../claudeTrust.js';
import { renderTaskMarkdown } from './instructions.js';
import { LATTICE_EXCLUDE_PATTERNS } from './managedFiles.js';
import {
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
): Promise<string> {
  // Home-scoped worktrees sit outside the project's `.git`, so Claude treats
  // each fresh worktree as its own untrusted project root. Pre-accept the
  // trust dialog so the Run flow stays one-click. Always seeded — a Pi/Codex
  // task that later hits a merge conflict spawns a Claude resolver in here.
  await ensureTrustedClaudeDir(worktreePath);

  const taskFile = path.join(worktreePath, 'LATTICE_TASK.md');
  await fs.writeFile(
    taskFile,
    renderTaskMarkdown(task, backendOrigin, harness, envNotes),
    'utf8',
  );
  // The Claude Stop hook is installed for every worktree regardless of run
  // harness: a Pi/Codex task that later hits a merge conflict spawns a
  // *Claude* resolver, which relies on this hook to call `/complete`.
  await installStopHook(worktreePath, task.id, backendOrigin);
  // Pi has no command-hook mechanism; install its TypeScript-extension
  // equivalent so the in-worktree Pi session reports completion on exit.
  if (harness === 'pi') {
    await installPiCompletionExtension(worktreePath, task.id, backendOrigin);
  }
  // Keep Lattice-managed files out of `git status` so Claude's `git add .`
  // never stages them. Writes to the worktree-local exclude (not the repo
  // .gitignore) so the project's tracked files are untouched.
  await writeWorktreeExclude(worktreePath, [...LATTICE_EXCLUDE_PATTERNS]);

  return taskFile;
}
