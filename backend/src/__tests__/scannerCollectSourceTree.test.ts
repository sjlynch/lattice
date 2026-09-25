import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectSourceFiles, collectSourceTree } from '../scanner/collectSourceTree.js';
import { loadGitignore } from '../scanner/ignore.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

function toRel(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

function sortedRel(root: string, absPaths: string[]): string[] {
  return absPaths.map((file) => toRel(root, file)).sort();
}

test('collectSourceTree collects source files, visible directories, and honors ignores', async () => {
  await withTempDir('lattice-scan-tree-', async (root) => {
    await writeLayout(root, {
      '.git/config': '[core]\n',
      '.gitignore': 'ignored-dir/\n*.generated.ts\n',
      'README.md': '# docs\n',
      'image.png': 'not source\n',
      'src/index.ts': 'export const x = 1;\n',
      'src/component.tsx': 'export function Component() { return null; }\n',
      'src/nested/util.py': 'print("ok")\n',
      'src/nested/asset.png': 'not source\n',
      'src/ignored.generated.ts': 'export const ignored = true;\n',
      'ignored-dir/hidden.ts': 'export const hidden = true;\n',
      'node_modules/pkg/index.js': 'module.exports = {};\n',
      'docs/notes.txt': 'not source\n',
    });

    const ignoreFilter = await loadGitignore(root);
    const tree = await collectSourceTree(root, ignoreFilter);

    assert.deepEqual(sortedRel(root, tree.files), [
      'README.md',
      'src/component.tsx',
      'src/index.ts',
      'src/nested/util.py',
    ]);
    assert.deepEqual(sortedRel(root, await collectSourceFiles(root, ignoreFilter)), [
      'README.md',
      'src/component.tsx',
      'src/index.ts',
      'src/nested/util.py',
    ]);

    const dirs = new Map(tree.directories.map((dir) => [toRel(root, dir.path), dir]));
    assert.deepEqual([...dirs.keys()].sort(), ['docs', 'src', 'src/nested']);
    assert.equal(dirs.get('src')?.id, path.join(root, 'src'));
    assert.equal(dirs.get('src')?.parentId, root);
    assert.equal(dirs.get('src/nested')?.id, path.join(root, 'src', 'nested'));
    assert.equal(dirs.get('src/nested')?.parentId, path.join(root, 'src'));
    assert.equal(dirs.get('docs')?.parentId, root);
  });
});

test('collectSourceTree skips a disappearing directory without failing the scan', async (t) => {
  await withTempDir('lattice-scan-tree-disappearing-', async (root) => {
    await writeLayout(root, {
      'src/keep.ts': 'export const keep = true;\n',
      'vanish/gone.ts': 'export const gone = true;\n',
    });

    const ignoreFilter = await loadGitignore(root);
    const realReaddir = fs.readdir.bind(fs);
    const vanishingDir = path.join(root, 'vanish');
    t.mock.method(fs, 'readdir', async (dir: PathLike, options?: object) => {
      if (path.resolve(String(dir)) === path.resolve(vanishingDir)) {
        throw Object.assign(new Error('directory disappeared'), { code: 'ENOENT' });
      }
      return realReaddir(dir, options as Parameters<typeof fs.readdir>[1]);
    });

    const tree = await collectSourceTree(root, ignoreFilter);

    assert.deepEqual(sortedRel(root, tree.files), ['src/keep.ts']);
    assert.ok(tree.directories.some((dir) => toRel(root, dir.path) === 'vanish'));
  });
});

// Lattice records its managed files (the root `.pi/extensions/lattice-*.ts`
// shims, …) in the repo-local, untracked `.git/info/exclude` instead of the
// user's tracked `.gitignore` — so the graph scanner must honor that file too,
// from a main checkout (`.git` dir) and a linked worktree (`.git` pointer file
// → gitdir → `commondir`).
test('loadGitignore honors the common gitdir info/exclude, from a checkout and a linked worktree', async () => {
  await withTempDir('lattice-scan-exclude-', async (root) => {
    const repo = path.join(root, 'repo');
    await writeLayout(repo, {
      '.git/info/exclude': '# lattice-managed (do not remove)\n.pi/extensions/lattice-subagents.ts\n',
      '.pi/extensions/lattice-subagents.ts': 'export {};\n',
      'src/index.ts': 'export {};\n',
    });
    const inRepo = await loadGitignore(repo);
    assert.equal(inRepo.ignores('.pi/extensions/lattice-subagents.ts'), true);
    assert.equal(inRepo.ignores('src/index.ts'), false);

    const wt = path.join(root, 'wt');
    const wtGitDir = path.join(repo, '.git', 'worktrees', 'wt');
    await writeLayout(wtGitDir, { commondir: '../..\n' });
    await writeLayout(wt, { '.git': `gitdir: ${wtGitDir}\n`, 'src/a.ts': '' });
    const inWorktree = await loadGitignore(wt);
    assert.equal(inWorktree.ignores('.pi/extensions/lattice-subagents.ts'), true);
  });
});
