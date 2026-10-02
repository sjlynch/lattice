// watchTree backs the two whole-tree watchers (health + git-status).
//
// The headline case is the Windows directory lock it exists to fix: chokidar
// opens an fs.watch handle per directory and per file, and on Windows an open
// handle anywhere inside a directory makes that directory impossible to rename
// or delete. Every Lattice project has a coding agent working in it, so that
// turned ordinary `mv`/`rm -rf` of a project subdirectory into "Access is
// denied" for as long as Lattice had the project open. The recursive backend
// holds ONE handle, on the root, so nothing below it is pinned.
//
// The rest pins the event derivation: the recursive backend has no native
// add/change/unlink notion, it derives them by diffing a snapshot, so the
// chokidar-shaped contract has to be asserted explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { watchTree, type TreeWatcher } from '../watchTree.js';
import { RecursiveTreeWatcher } from '../watchTree/recursiveWatcher.js';
import { withTempDir } from './helpers/tempDir.js';

type Recorded = { event: string; filePath: string };

// Generous enough to cover the flush debounce plus the write-stability hold on
// a loaded machine, without making the suite crawl.
const SETTLE_MS = 700;

const settle = (ms = SETTLE_MS) => new Promise((r) => setTimeout(r, ms));

function record(watcher: TreeWatcher): Recorded[] {
  const seen: Recorded[] = [];
  for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
    watcher.on(event, (filePath: string) => seen.push({ event, filePath }));
  }
  watcher.on('error', () => { /* surfaced to the caller in production */ });
  return seen;
}

function has(seen: Recorded[], event: string, filePath: string): boolean {
  return seen.some((s) => s.event === event && s.filePath === filePath);
}

test('watchTree reports add / change / unlink for files', async () => {
  await withTempDir('lattice-watchtree-files-', async (dir) => {
    const watcher = watchTree(dir, { ignored: () => false });
    const seen = record(watcher);
    try {
      await settle();
      const file = path.join(dir, 'a.ts');

      await fs.writeFile(file, 'export const a = 1;', 'utf8');
      await settle();
      assert.ok(has(seen, 'add', file), `expected add for a.ts, got ${JSON.stringify(seen)}`);

      await fs.writeFile(file, 'export const a = 2; // longer now', 'utf8');
      await settle();
      assert.ok(has(seen, 'change', file), `expected change for a.ts, got ${JSON.stringify(seen)}`);

      await fs.rm(file);
      await settle();
      assert.ok(has(seen, 'unlink', file), `expected unlink for a.ts, got ${JSON.stringify(seen)}`);
    } finally {
      await watcher.close();
    }
  });
});

test('watchTree reports addDir, nested adds, and a recursive delete', async () => {
  await withTempDir('lattice-watchtree-dirs-', async (dir) => {
    const watcher = watchTree(dir, { ignored: () => false });
    const seen = record(watcher);
    try {
      await settle();
      const sub = path.join(dir, 'sub');
      const nested = path.join(sub, 'b.ts');

      await fs.mkdir(sub);
      await fs.writeFile(nested, 'export const b = 1;', 'utf8');
      await settle();
      assert.ok(has(seen, 'addDir', sub), `expected addDir for sub, got ${JSON.stringify(seen)}`);
      assert.ok(has(seen, 'add', nested), `expected add for sub/b.ts, got ${JSON.stringify(seen)}`);

      // A recursive delete may only be reported for the top directory, so the
      // watcher has to synthesize the removals of everything it had recorded
      // underneath — otherwise the health graph keeps stale nodes forever.
      await fs.rm(sub, { recursive: true, force: true });
      await settle();
      assert.ok(has(seen, 'unlink', nested), `expected unlink for sub/b.ts, got ${JSON.stringify(seen)}`);
      assert.ok(has(seen, 'unlinkDir', sub), `expected unlinkDir for sub, got ${JSON.stringify(seen)}`);
    } finally {
      await watcher.close();
    }
  });
});

test('watchTree never reports paths the ignore predicate rejects', async () => {
  await withTempDir('lattice-watchtree-ignored-', async (dir) => {
    const watcher = watchTree(dir, {
      ignored: (p) => p.split(path.sep).includes('node_modules'),
    });
    const seen = record(watcher);
    try {
      await settle();
      const vendored = path.join(dir, 'node_modules', 'pkg');
      await fs.mkdir(vendored, { recursive: true });
      await fs.writeFile(path.join(vendored, 'index.js'), 'module.exports = 1;', 'utf8');
      const real = path.join(dir, 'real.ts');
      await fs.writeFile(real, 'export const r = 1;', 'utf8');
      await settle();

      assert.ok(has(seen, 'add', real), `expected add for real.ts, got ${JSON.stringify(seen)}`);
      assert.equal(
        seen.filter((s) => s.filePath.includes('node_modules')).length,
        0,
        `node_modules must never be reported, got ${JSON.stringify(seen)}`,
      );
    } finally {
      await watcher.close();
    }
  });
});

// The regression this module exists for. On Windows chokidar's per-directory
// handles make `parent` (any directory containing a subdirectory) un-renameable
// and un-deletable while watched; the recursive backend must not.
test('watching a tree does not lock its directories against rename/delete', async () => {
  if (process.platform !== 'win32') return; // the lock is a Windows-only behavior
  await withTempDir('lattice-watchtree-lock-', async (dir) => {
    const watcher = watchTree(dir, { ignored: () => false });
    record(watcher);
    try {
      const parent = path.join(dir, 'parent');
      await fs.mkdir(path.join(parent, 'child'), { recursive: true });
      await fs.writeFile(path.join(parent, 'child', 'c.ts'), 'export const c = 1;', 'utf8');
      await settle();

      const renamed = path.join(dir, 'parent-renamed');
      await fs.rename(parent, renamed); // throws EPERM under per-directory watches
      await fs.rm(renamed, { recursive: true, force: true });

      assert.equal(await exists(renamed), false);
    } finally {
      await watcher.close();
    }
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// On a case-insensitive filesystem the OLD spelling of a case-only rename still
// stats, with unchanged (mtime,size), so a plain snapshot diff reported only
// the new spelling's `add` and kept a phantom `Foo.ts` (and every subscriber's
// graph node for it) forever.
test('watchTree reports a case-only rename as unlink(old) + add(new)', async () => {
  if (process.platform !== 'win32') return; // the recursive backend's platform
  await withTempDir('lattice-watchtree-case-', async (dir) => {
    const watcher = watchTree(dir, { ignored: () => false });
    const seen = record(watcher);
    try {
      await settle();
      const upper = path.join(dir, 'Foo.ts');
      const lower = path.join(dir, 'foo.ts');
      await fs.writeFile(upper, 'export const f = 1;', 'utf8');
      await settle();
      assert.ok(has(seen, 'add', upper), `expected add for Foo.ts, got ${JSON.stringify(seen)}`);

      await fs.rename(upper, lower);
      await settle();
      assert.ok(has(seen, 'add', lower), `expected add for foo.ts, got ${JSON.stringify(seen)}`);
      assert.ok(has(seen, 'unlink', upper), `expected unlink for Foo.ts, got ${JSON.stringify(seen)}`);
    } finally {
      await watcher.close();
    }
  });
});

// A file younger than WRITE_STABILITY_MS gets a `retries` entry and is held for
// another pass. If it is gone by then it was never recorded, and the removal
// path used to return before dropping that entry — so every short-lived file
// (the `.git` watcher sees a unique `index.lock` / `<branch>.lock` per task)
// leaked one for the backend's lifetime.
test('a young file unlinked before its next pass leaves no retry entry and no event', async () => {
  if (process.platform !== 'win32') return; // the recursive backend's platform
  await withTempDir('lattice-watchtree-retries-', async (dir) => {
    const watcher = new RecursiveTreeWatcher(dir, { ignored: () => false });
    const seen = record(watcher);
    const waitFor = async (cond: () => boolean, what: string, onTick?: () => Promise<void>) => {
      const deadline = Date.now() + 5_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await onTick?.();
        await settle(10);
      }
    };
    try {
      await settle();
      const file = path.join(dir, 'short-lived.lock');
      await fs.writeFile(file, 'lock', 'utf8');
      // Keep its mtime fresh so whichever pass sees it finds it still young.
      await waitFor(() => watcher.stabilityRetryCount > 0, 'the young file to be held', async () => {
        const now = new Date();
        await fs.utimes(file, now, now);
      });

      await fs.rm(file);
      await waitFor(() => watcher.stabilityRetryCount === 0, 'the retry entry to be dropped');
      await settle();
      assert.equal(watcher.stabilityRetryCount, 0);
      assert.deepEqual(
        seen.filter((s) => s.filePath === file),
        [],
        `expected no events for the never-seen file, got ${JSON.stringify(seen)}`,
      );
    } finally {
      await watcher.close();
    }
  });
});
