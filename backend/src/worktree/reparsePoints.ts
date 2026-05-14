// Strip Windows junctions / symbolic links that live *inside* a worktree.
// Split out of cleanup.ts so the (somewhat involved) traversal logic lives
// in its own file and the cleanup pipeline reads as straight orchestration.
//
// A directory reparse point (Windows junction / symlink) that lives
// *inside* a worktree and points at an ancestor of itself is both a
// recursive-delete landmine and the reason `git worktree remove` fails
// outright on Windows ("failed to delete <wt>: Function not implemented" —
// git's own recursion walks the loop until it blows past MAX_PATH, then
// aborts and leaves the whole worktree behind). These appear when an agent
// runs `npm install` inside a worktree and some package declares a
// `file:..` self-dependency: npm materialises `node_modules/<pkg>` as a
// junction back to the package root. We can't stop the agent from doing
// that — but before any worktree teardown we sweep the worktree and remove
// *just the link* for every reparse point we find (rmdir/unlink the
// junction entry itself — never recurse into it, never touch its target).
// With the loop broken, `git worktree remove` succeeds and any subsequent
// recursive delete is finite again. This is also what lets the boot-time
// `sweepOrphanedWorktrees` actually converge on a worktree that a previous
// run failed to remove for exactly this reason.
//
// Terminating + side-effect-light by construction: it never descends into a
// reparse point (so the walk only ever covers the real, finite tree);
// inside any `node_modules/` directory it inspects only the direct children
// and `@scope/` children (that's where a `file:` self-dep junction lands —
// skipping the thousands of ordinary package subtrees keeps this off the
// critical path); a hard depth cap is a final backstop; and it only ever
// removes a link whose path is strictly inside `rootDir`. Returns the count
// of reparse points removed.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isPathStrictlyInside } from './paths.js';

export async function pruneReparsePointsUnder(
  rootDir: string,
  maxDepth = 24,
): Promise<number> {
  const realRoot = path.resolve(rootDir);
  let removed = 0;

  async function removeLink(linkPath: string): Promise<void> {
    const resolved = path.resolve(linkPath);
    // linkPath is always built by path.join under rootDir, so this is
    // belt-and-suspenders — but never remove the root itself or anything
    // outside it.
    if (!isPathStrictlyInside(realRoot, resolved)) {
      console.warn(
        `[worktree] pruneReparsePoints: skipping ${linkPath} — not strictly inside ${rootDir}.`,
      );
      return;
    }
    // A directory junction needs rmdir; a file symlink needs unlink. On
    // Windows libuv routes a directory reparse point through RemoveDirectory
    // for both, so unlink almost always suffices — fall back to rmdir for
    // the odd case where it doesn't. Either way this removes the *link*, not
    // the directory it points at.
    try {
      await fs.unlink(resolved);
    } catch {
      await fs.rmdir(resolved);
    }
    removed += 1;
    console.warn(`[worktree] removed reparse point inside worktree: ${resolved}`);
  }

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(
          `[worktree] pruneReparsePoints: cannot read ${dir} (${code ?? 'unknown'}) — skipping.`,
        );
      }
      return;
    }
    const inNodeModules = path.basename(dir) === 'node_modules';
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      // libuv reports both symlinks and Windows junctions as UV_DIRENT_LINK,
      // i.e. Dirent.isSymbolicLink() === true. That's the reparse-point case.
      if (ent.isSymbolicLink()) {
        try {
          await removeLink(full);
        } catch (err) {
          console.warn(`[worktree] pruneReparsePoints: could not remove ${full}:`, err);
        }
        continue; // never recurse into a reparse point
      }
      if (!ent.isDirectory()) continue;
      // Inside node_modules, only `@scope/` dirs can hold a `file:` self-dep
      // junction one level deeper; everything else is an ordinary package
      // subtree git's own delete handles fine.
      if (inNodeModules && !ent.name.startsWith('@')) continue;
      await visit(full, depth + 1);
    }
  }

  await visit(realRoot, 0);
  return removed;
}
