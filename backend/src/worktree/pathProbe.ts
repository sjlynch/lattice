import fs from 'node:fs/promises';

// Strict existence probe for the worktree-removal / discard-archive paths.
// `lstat`, not `stat`: a junction/symlink is itself the thing that exists, never
// followed. Only ENOENT means absent — a permission failure is unknown state,
// never evidence of absence, so every other error propagates to the caller.
export async function pathExistsStrict(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
