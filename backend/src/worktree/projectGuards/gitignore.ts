import path from 'node:path';
import fs from 'node:fs/promises';
import { LATTICE_GITIGNORE_ENTRIES } from '../managedFiles.js';

// Append `.claude/settings.local.json` to the repo's root .gitignore if
// it isn't already covered. Idempotent: scans the existing file for
// either the literal entry or any line that would match it via gitignore
// pattern semantics. Bails silently if the project has no .gitignore
// (creating one would surprise the user); the worktree-local exclude
// still protects merges in that case.
export const LATTICE_GITIGNORE_MARKER = '# lattice-managed (do not remove)';

export async function ensureLatticeGitignore(repoRoot: string): Promise<void> {
  const ignoreFile = path.join(repoRoot, '.gitignore');
  let existing: string;
  try {
    existing = await fs.readFile(ignoreFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn('[worktree] could not read .gitignore:', err);
    return;
  }
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = LATTICE_GITIGNORE_ENTRIES.filter(
    (entry) => !lines.some((l) => l === entry || l === `/${entry}`),
  );
  if (missing.length === 0) return;
  const trailingNewline = existing.endsWith('\n') ? '' : '\n';
  const block =
    `${trailingNewline}\n${LATTICE_GITIGNORE_MARKER}\n${missing.join('\n')}\n`;
  try {
    await fs.appendFile(ignoreFile, block, 'utf8');
    console.log(
      `[worktree] appended ${missing.length} entry(ies) to ${ignoreFile}`,
    );
  } catch (err) {
    console.warn('[worktree] could not append to .gitignore:', err);
  }
}
