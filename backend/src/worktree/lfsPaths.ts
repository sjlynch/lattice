// LFS-tracked paths of the project repo, and the LATTICE_TASK.md note a
// pointer-mode worktree gets (see lfsMode.ts).

import path from 'node:path';
import { projectGit } from './projectGit.js';
import type { LfsCheckoutMode } from './lfsMode.js';

const LS_FILES_TIMEOUT_MS = 60_000;

// Every tracked path whose `filter` attribute is `lfs` (`:(attr:…)` pathspec
// magic — one read-only `ls-files`, no `git lfs` binary needed). null when git
// fails.
export async function listLfsTrackedPaths(repoRoot: string): Promise<string[] | null> {
  const r = await projectGit(repoRoot, ['ls-files', '-z', '--', ':(attr:filter=lfs)'], {
    timeoutMs: LS_FILES_TIMEOUT_MS,
  });
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}

// The LATTICE_TASK.md note for a pointer-mode worktree of a repo that has LFS
// files (null otherwise). One paragraph, so it composes into the env-notes
// blockquote (`{{env_notes_block}}`). Best-effort: any failure omits the note.
export async function lfsPointerNoteFor(
  repoRoot: string,
  mode: LfsCheckoutMode,
): Promise<string | null> {
  if (mode !== 'pointers') return null;
  try {
    const paths = await listLfsTrackedPaths(repoRoot);
    if (!paths || paths.length === 0) return null;
    return renderLfsPointerNote(paths);
  } catch {
    return null;
  }
}

export function renderLfsPointerNote(lfsPaths: string[]): string {
  const exts = [...new Set(lfsPaths.map((p) => path.extname(p).toLowerCase()).filter(Boolean))];
  const sample = exts.slice(0, 4).map((e) => `\`*${e}\``).join(', ');
  return (
    `**Git LFS files are pointer stubs here.** To save disk, this worktree's ${lfsPaths.length} ` +
    `Git LFS file(s)${sample ? ` (${sample}${exts.length > 4 ? ', …' : ''})` : ''} are checked out as ` +
    `small text pointers, not their content — editing code doesn't need them. If you need a ` +
    `file's real content, run \`git lfs pull --include="<path>"\` (it reads the local LFS ` +
    `store, fetching only what is missing).`
  );
}
