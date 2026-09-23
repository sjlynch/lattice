import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../../tasks.js';
import {
  CHECKOUT_THEIRS_FOOTER,
  CONFLICT_MARKERS,
  STASH_FILES_LIST_HINT,
  renderConflictedFilesList,
  renderEnvBlockFor,
  renderStashDropSteps,
} from './shared.js';

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
  const envBlock = await renderEnvBlockFor(repoRoot);
  const filesList = renderConflictedFilesList(
    conflictedFiles,
    STASH_FILES_LIST_HINT,
  );
  const md = `# Resolve stash-pop conflict for "${task.title}"

**Task ID:** ${task.id}

${envBlock}Lattice fast-forwarded \`main\` to the merged branch tip, then tried to restore
your uncommitted working-tree changes via \`git stash pop\`. That pop failed with
conflicts. Your job is to resolve those conflicts and finish the cleanup.

## Task description

${desc}

## Conflicted files

${filesList}

## Steps (complete autonomously — no need to confirm with the user)

Don't run the test suite, builds or type-checks — only resolve the markers.

1. For each conflicted file, resolve all ${CONFLICT_MARKERS}
   markers. Keep both the merged branch's changes AND the original working-tree
   changes wherever possible.
2. Stage each resolved file: \`git add <file> ...\`
3. Drop the stash entry — find it by label then drop it:
${renderStashDropSteps(stashLabel)}
4. Notify Lattice:
   \`\`\`
   curl -s -m 5 -X POST ${backendOrigin}/api/tasks/${task.id}/stash-resolved
   \`\`\`
5. Delete this file: \`del ${fileName}\` (Windows) or \`rm ${fileName}\`

${CHECKOUT_THEIRS_FOOTER}`;
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
  const envBlock = await renderEnvBlockFor(repoRoot);
  const filesList = renderConflictedFilesList(
    conflictedFiles,
    STASH_FILES_LIST_HINT,
  );
  const md = `# Resolve working-tree stash conflict

${envBlock}All queued tasks were merged. When Lattice tried to restore your uncommitted
working-tree changes via \`git stash pop\`, the pop failed with conflicts.
Resolve them so your working tree is clean again.

## Conflicted files

${filesList}

## Steps (complete autonomously — no need to confirm with the user)

Don't run the test suite, builds or type-checks — only resolve the markers.

1. Resolve all ${CONFLICT_MARKERS} markers in each file.
   Keep both sides where possible.
2. Stage each resolved file: \`git add <file> ...\`
3. Drop the stash entry (it stays in the list after a failed pop):
${renderStashDropSteps(stashLabel)}
4. Notify Lattice that the conflict is resolved:
   \`\`\`
   curl -s -m 5 -X POST ${backendOrigin}/api/merge-runs/${runId}/stash-resolved
   \`\`\`
5. Delete this file: \`del ${fileName}\` (Windows) or \`rm ${fileName}\`

${CHECKOUT_THEIRS_FOOTER}`;
  await fs.writeFile(file, md, 'utf8');
  return { instructionsFile: file, relativePath: fileName };
}
