// package.json entry-point roots for the dead-code pass. A `scripts` command
// used to be split on whitespace only, so the file it runs was missed — and
// flagged dead, with everything only it reaches — whenever the path was glued
// to a shell operator, quoted, or given as a `--flag=path` option.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readPackageJsonRoots, scriptPathTokens } from '../health/crossFile/packageRoots.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

test('scriptPathTokens splits shell operators, strips quotes and --flag= prefixes', () => {
  assert.deepEqual(scriptPathTokens('node a.mjs&&node "b/c.mjs"'), ['node', 'a.mjs', 'node', 'b/c.mjs']);
  assert.deepEqual(scriptPathTokens("tsx --import=./src/reg.ts 'src/main.ts'; echo ok"), [
    'tsx', './src/reg.ts', 'src/main.ts', 'echo', 'ok',
  ]);
  assert.deepEqual(scriptPathTokens('a | b || c'), ['a', 'b', 'c']);
});

test('readPackageJsonRoots resolves quoted / operator-glued / --flag= script paths', async () => {
  await withTempDir('lattice-pkgroots-', async (dir) => {
    await writeLayout(dir, {
      'package.json': JSON.stringify({
        scripts: {
          build: 'node lib/build.mjs&&node lib/post.js',
          start: 'node "app/start.ts"',
          dev: 'node --import=./app/register.ts app/other.ts',
        },
      }),
      'lib/build.mjs': '',
      'lib/post.js': '',
      'app/start.ts': '',
      'app/register.ts': '',
      'app/other.ts': '',
    });
    const files = ['lib/build.mjs', 'lib/post.js', 'app/start.ts', 'app/register.ts', 'app/other.ts']
      .map((rel) => path.join(dir, ...rel.split('/')));
    const roots = await readPackageJsonRoots(dir, new Set(files));
    for (const f of files) assert.ok(roots.has(f), `expected ${f} as a root, got ${[...roots].join(', ')}`);
  });
});
