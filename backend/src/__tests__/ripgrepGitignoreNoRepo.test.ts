import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRipgrep, searchWithRipgrep } from '../ripgrep.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

// Regression: rg honors .gitignore only inside a git repo unless told
// otherwise, while the scanner applies the root .gitignore to every project.
// In a folder that isn't a repo yet, the content search therefore returned
// ignored build output — paths the graph has no node for — and those ate the
// match limit ahead of real source hits.
const rg = await resolveRipgrep();

test('rg content search applies .gitignore in a folder that is not a git repo', { skip: rg ? false : 'ripgrep not installed' }, async () => {
  await withTempDir('lattice-rg-norepo-', async (dir) => {
    await writeLayout(dir, {
      '.gitignore': 'dist/\n',
      'dist/bundle.ts': 'needle\n',
      'src/a.ts': 'needle\n',
    });
    const { matches } = await searchWithRipgrep(rg as string, dir, {
      regexSource: 'needle',
      limit: 100,
      maxFileBytes: 1024 * 1024,
    });
    assert.deepEqual(matches, [path.resolve(dir, 'src', 'a.ts')]);
  });
});
