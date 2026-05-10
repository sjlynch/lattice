import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneReparsePointsUnder } from '../worktree/cleanup.js';

// Reproduces the shape that wedged a real "merge all": an in-worktree
// `npm install` of a `file:..` self-dependency leaves `node_modules/<pkg>`
// as a junction back to the worktree root, which makes `git worktree
// remove` (and any naive recursive delete) walk an infinite loop on
// Windows. pruneReparsePointsUnder must strip just the link and leave the
// real tree untouched. We create the links with type 'junction' — that's
// unprivileged on Windows (unlike 'file'/'dir' symlinks) and is ignored
// (→ ordinary symlink) on other platforms, so the test runs anywhere.
test('pruneReparsePointsUnder removes junction/symlink entries, keeps real files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-prune-'));
  try {
    await fs.mkdir(path.join(root, 'frontend', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'frontend', 'src', 'keep.txt'), 'keep');
    await fs.mkdir(path.join(root, 'frontend', 'node_modules', 'react'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'frontend', 'node_modules', 'react', 'index.js'),
      'module.exports = {};',
    );

    // The landmine: node_modules/lattice -> the worktree root itself.
    await fs.symlink(
      root,
      path.join(root, 'frontend', 'node_modules', 'lattice'),
      'junction',
    );
    // A second reparse point at the top level, pointing elsewhere inside root.
    await fs.symlink(
      path.join(root, 'frontend', 'src'),
      path.join(root, 'link-to-src'),
      'junction',
    );

    const removed = await pruneReparsePointsUnder(root);
    assert.equal(removed, 2);

    // Links are gone...
    await assert.rejects(
      fs.lstat(path.join(root, 'frontend', 'node_modules', 'lattice')),
      /ENOENT/,
    );
    await assert.rejects(fs.lstat(path.join(root, 'link-to-src')), /ENOENT/);

    // ...and the real tree survived (in particular we did NOT follow the
    // junction into root and delete keep.txt).
    assert.equal(
      await fs.readFile(path.join(root, 'frontend', 'src', 'keep.txt'), 'utf8'),
      'keep',
    );
    assert.ok(
      (await fs.stat(path.join(root, 'frontend', 'node_modules', 'react'))).isDirectory(),
    );
    assert.equal(
      await fs.readFile(path.join(root, 'frontend', 'node_modules', 'react', 'index.js'), 'utf8'),
      'module.exports = {};',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pruneReparsePointsUnder is a no-op on a tree with no reparse points', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-prune-clean-'));
  try {
    await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', 'b', 'f.txt'), 'x');
    const removed = await pruneReparsePointsUnder(root);
    assert.equal(removed, 0);
    assert.equal(await fs.readFile(path.join(root, 'a', 'b', 'f.txt'), 'utf8'), 'x');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
