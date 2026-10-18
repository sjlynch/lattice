import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../../tasks.js';
import { applyTemplate } from '../../instructionTemplates/apply.js';
import { resolveInstructionTemplate } from '../../instructionTemplates/resolve.js';
import { DEFAULT_MERGE_TEMPLATE } from '../../instructionTemplates/defs.js';
import { ensureValidStopHook } from './stopHookRepair.js';
import { isTaskAgentTypecheckEnabled, isTaskAgentTestsEnabled } from '../../userSettings.js';
import { renderVerificationBlock, templateWithVerification, type VerificationOptions } from '../../taskVerification.js';
import {
  MERGE_FILES_LIST_HINT,
  renderConflictedFilesList,
  renderEnvBlockFor,
} from './shared.js';

// Pure renderer for the MERGE_INSTRUCTIONS.md body. Kept separate from the
// writer below so the same text can be previewed/edited (settings dialog)
// without doing any filesystem work or installing a Stop hook. The caller
// supplies the already-resolved env-notes block and template.
export function renderMergeInstructions(
  task: Task,
  branch: string,
  conflictedFiles: string[],
  backendOrigin: string,
  envBlock: string,
  template: string = DEFAULT_MERGE_TEMPLATE,
  verification: VerificationOptions = { typecheck: false, tests: false },
): string {
  const desc = task.description?.trim() || '_(no description provided)_';
  const filesList = renderConflictedFilesList(
    conflictedFiles,
    MERGE_FILES_LIST_HINT,
  );
  return applyTemplate(templateWithVerification(template), {
    task_id: task.id,
    branch,
    task_title: task.title,
    task_description: desc,
    env_notes_block: envBlock,
    conflicted_files: filesList,
    backend_origin: backendOrigin,
    verification: renderVerificationBlock(verification),
  });
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
  const envBlock = await renderEnvBlockFor(task.projectPath);
  const template = await resolveInstructionTemplate(task.projectPath, 'merge');
  const typecheck = await isTaskAgentTypecheckEnabled(task.projectPath).catch(() => false);
  const tests = await isTaskAgentTestsEnabled(task.projectPath).catch(() => false);
  const md = renderMergeInstructions(
    task,
    branch,
    conflictedFiles,
    backendOrigin,
    envBlock,
    template,
    { typecheck, tests },
  );
  await fs.writeFile(file, md, 'utf8');
  return {
    instructionsFile: file,
    relativePath: fileName,
  };
}
