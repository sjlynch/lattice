// Shared snippets and helpers reused across the instruction-writer
// modules in this directory. The prose pieces here are duplicated into
// multiple rendered markdown files (LATTICE_TASK.md, MERGE_INSTRUCTIONS.md,
// STASH_CONFLICT_*.md), so centralising them keeps the wording in lockstep.

import { renderEnvNotesBlock, resolveEnvNotesForInstructions } from '../envDetect.js';

export const MERGE_FILES_LIST_HINT =
  '_(use `git diff --name-only --diff-filter=U` to list)_';
export const STASH_FILES_LIST_HINT =
  '_(run `git diff --name-only --diff-filter=U` to list)_';
export const CONFLICT_MARKERS = '`<<<<<<<` / `=======` / `>>>>>>>`';
export const MERGE_CONFLICT_MARKERS = CONFLICT_MARKERS.replace(
  ' / `>>>>>>>`',
  ' /\n   `>>>>>>>`',
);
export const CHECKOUT_THEIRS_FOOTER = `## If a file cannot be resolved cleanly

Use \`git checkout --theirs -- <file>\` (or \`--ours\`), stage it, and continue.
`;

export function renderConflictedFilesList(files: string[], listHint: string): string {
  return files.length > 0 ? files.map((f) => `- \`${f}\``).join('\n') : listHint;
}

export function renderStashDropSteps(stashLabel: string): string {
  return `   \`\`\`
   git stash list          # find the entry labelled "${stashLabel}"
   git stash drop stash@{N}
   \`\`\``;
}

export async function renderEnvBlockFor(repoRoot: string): Promise<string> {
  return renderEnvNotesBlock(await resolveEnvNotesForInstructions(repoRoot));
}
