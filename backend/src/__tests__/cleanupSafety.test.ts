// Direct coverage for the two throw-guards in `worktree/cleanupSafety.ts`.
//
// These are the inner ring of the `.git`-deletion defences (#3/#8 in the root
// CLAUDE.md): `assertSafeWorktreePath` bounds *where* a worktree teardown may
// point before it reaches `git worktree remove`, and `assertNotReparsePoint`
// refuses every remaining `fs.rm` site whose path is (or is reached through) a
// symlink/junction. Three prior incidents on this project were a recursive
// delete reaching `.git`; a regression in either guard re-opens that class, so
// both get pinned here rather than being covered only indirectly.
//
// Pure/temp-dir unit test — no real git repo needed. Reparse points are created
// with `fs.symlink(target, path, 'junction')`: unprivileged on Windows (unlike
// 'file'/'dir' symlinks) and ignored (→ ordinary symlink) elsewhere, so the
// same fixture runs on every platform. Same trick as pruneReparsePoints.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeWorktreePath,
  assertNotReparsePoint,
} from '../worktree/cleanupSafety.js';
import { homeWorktreesDir } from '../projectPath.js';
import { withTempDir } from './helpers/tempDir.js';

// Path-only fixtures — assertSafeWorktreePath never touches the filesystem.
const repo = path.resolve('/repo');
const otherRepo = path.resolve('/other-repo');

test('assertSafeWorktreePath refuses an empty or whitespace-only path', () => {
  // An empty task.worktreePath would resolve to the backend's cwd.
  assert.throws(
    () => assertSafeWorktreePath(repo, ''),
    /refusing teardown of an empty worktree path/,
  );
  assert.throws(
    () => assertSafeWorktreePath(repo, '   '),
    /refusing teardown of an empty worktree path/,
  );
});

test('assertSafeWorktreePath refuses the repo root itself', () => {
  assert.throws(
    () => assertSafeWorktreePath(repo, repo),
    /that is the repo root/,
  );
  // Also in a non-normalized spelling — the check resolves first.
  assert.throws(
    () => assertSafeWorktreePath(repo, path.join(repo, 'sub', '..')),
    /that is the repo root/,
  );
});

test('assertSafeWorktreePath refuses paths outside every managed worktrees dir', () => {
  const outside = [
    // Somewhere else entirely.
    path.resolve('/somewhere/else'),
    // Inside the repo, but not a worktree — the shapes that have historically
    // cost a `.git`.
    path.join(repo, 'src'),
    path.join(repo, '.git'),
    // The managed base dir itself: strictly-inside only, so tearing down the
    // whole `~/.lattice/worktrees/<hash>/` directory is refused too.
    homeWorktreesDir(repo),
    // Another project's managed dir — a wrong-project task.worktreePath.
    path.join(homeWorktreesDir(otherRepo), 'slug-abc123'),
  ];
  for (const worktreePath of outside) {
    assert.throws(
      () => assertSafeWorktreePath(repo, worktreePath),
      /not under a Lattice-managed worktrees directory/,
      `expected refusal for ${worktreePath}`,
    );
  }
});

test('assertSafeWorktreePath accepts a real managed worktree path', () => {
  // Current location: ~/.lattice/worktrees/<projectHash>/<slug>-<id>
  assert.doesNotThrow(() =>
    assertSafeWorktreePath(repo, path.join(homeWorktreesDir(repo), 'slug-abc123')),
  );
  // Legacy in-project location (worktrees created before 2026-05-10) still
  // has to tear down, or those never get reclaimed.
  assert.doesNotThrow(() =>
    assertSafeWorktreePath(repo, path.join(repo, '.lattice', 'worktrees', 'slug-abc123')),
  );
});

test('assertNotReparsePoint is a no-op on real files and directories', async () => {
  await withTempDir('lattice-cleanupsafety-real-', async (dir) => {
    // realpath the temp root first: on Windows os.tmpdir() can hand back an
    // 8.3 short-name alias, which is itself a realpath mismatch and would make
    // even a perfectly ordinary directory look like a reparse point.
    const root = await fs.realpath(dir);
    await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'b', 'f.txt'), 'x');

    await assertNotReparsePoint(root);
    await assertNotReparsePoint(path.join(root, 'a', 'b'));
    await assertNotReparsePoint(path.join(root, 'a', 'b', 'f.txt'));
  });
});

test('assertNotReparsePoint returns silently when the path does not exist', async () => {
  await withTempDir('lattice-cleanupsafety-enoent-', async (dir) => {
    const root = await fs.realpath(dir);
    // Callers are expected to swallow ENOENT — an absent path is not unsafe,
    // and cleanup runs on paths that may already be gone.
    await assertNotReparsePoint(path.join(root, 'gone'));
    await assertNotReparsePoint(path.join(root, 'gone', 'deeper', 'still'));
  });
});

test('assertNotReparsePoint throws on a junction back to the worktree root', async () => {
  await withTempDir('lattice-cleanupsafety-link-', async (dir) => {
    const root = await fs.realpath(dir);
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true });

    // The landmine: an in-worktree `npm install` of a `file:..` self-dep leaves
    // node_modules/<pkg> as a junction pointing back at the worktree root.
    const landmine = path.join(worktree, 'node_modules', 'lattice');
    await fs.symlink(worktree, landmine, 'junction');

    await assert.rejects(
      assertNotReparsePoint(landmine),
      // Windows reports a junction as a symlink via lstat, POSIX makes a plain
      // symlink here — either way one of the two refusals fires.
      /refusing fs\.rm on (symbolic link|reparse point)/,
    );

    // The guard only refuses; it never removes anything itself.
    assert.equal((await fs.lstat(landmine)).isSymbolicLink(), true);
  });
});

test('assertNotReparsePoint throws when the path is reached through a reparse point', async () => {
  await withTempDir('lattice-cleanupsafety-parent-', async (dir) => {
    const root = await fs.realpath(dir);
    await fs.mkdir(path.join(root, 'real', 'child'), { recursive: true });
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'), 'junction');

    const viaLink = path.join(root, 'link', 'child');
    // lstat only refuses to follow the FINAL component, so here it reports an
    // ordinary directory — this is precisely the case the realpath comparison
    // exists for, and the one an `fs.rm` would happily walk through.
    assert.equal((await fs.lstat(viaLink)).isSymbolicLink(), false);

    await assert.rejects(
      assertNotReparsePoint(viaLink),
      /refusing fs\.rm on reparse point/,
    );
  });
});
