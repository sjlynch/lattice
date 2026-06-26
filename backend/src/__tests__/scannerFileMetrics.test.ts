import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readForAnalysis } from '../scanner/fileMetrics.js';
import { LOC_MAX_BYTES } from '../health/constants.js';
import { withTempDir } from './helpers/tempDir.js';

test('readForAnalysis returns zero LOC and empty content for empty files', async () => {
  await withTempDir('lattice-scan-metrics-empty-', async (dir) => {
    const file = path.join(dir, 'empty.ts');
    await fs.writeFile(file, '');

    assert.deepEqual(await readForAnalysis(file), { loc: 0, content: '' });
  });
});

test('readForAnalysis counts LOC and returns normal file content', async () => {
  await withTempDir('lattice-scan-metrics-normal-', async (dir) => {
    const noTrailingNewline = path.join(dir, 'no-trailing.ts');
    const trailingNewline = path.join(dir, 'trailing.ts');
    await fs.writeFile(noTrailingNewline, 'const a = 1;\nconst b = 2;');
    await fs.writeFile(trailingNewline, 'const a = 1;\nconst b = 2;\n');

    assert.deepEqual(await readForAnalysis(noTrailingNewline), {
      loc: 2,
      content: 'const a = 1;\nconst b = 2;',
    });
    assert.deepEqual(await readForAnalysis(trailingNewline), {
      loc: 2,
      content: 'const a = 1;\nconst b = 2;\n',
    });
  });
});

test('readForAnalysis skips LOC and content for files over the hard byte cutoff', async () => {
  await withTempDir('lattice-scan-metrics-huge-', async (dir) => {
    const file = path.join(dir, 'huge.js');
    await fs.writeFile(file, Buffer.alloc(LOC_MAX_BYTES + 1, 0x61));

    assert.deepEqual(await readForAnalysis(file), {});
  });
});

test('readForAnalysis counts LOC but omits content for large minified single-line files', async () => {
  await withTempDir('lattice-scan-metrics-minified-', async (dir) => {
    const file = path.join(dir, 'bundle.min.js');
    await fs.writeFile(file, 'a'.repeat(70 * 1024));

    assert.deepEqual(await readForAnalysis(file), { loc: 1 });
  });
});

test('readForAnalysis safely returns an empty result for missing files', async () => {
  await withTempDir('lattice-scan-metrics-missing-', async (dir) => {
    assert.deepEqual(await readForAnalysis(path.join(dir, 'missing.ts')), {});
  });
});
