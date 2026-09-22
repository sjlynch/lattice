import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeFileMetrics, readForAnalysis } from '../scanner/fileMetrics.js';
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

test('readForAnalysis decodes a UTF-16 BOM file instead of feeding NUL-interleaved text to the analyzer', async () => {
  await withTempDir('lattice-scan-metrics-utf16-', async (dir) => {
    const text = 'const x = 1;\nconst y = 2;\n';
    const le = path.join(dir, 'le.ts');
    await fs.writeFile(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const leResult = await readForAnalysis(le);
    assert.equal(leResult.content, text);
    assert.equal(leResult.content?.includes('\0'), false);

    const be = path.join(dir, 'be.ts');
    await fs.writeFile(be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]));
    assert.equal((await readForAnalysis(be)).content, text);
  });
});

test('computeFileMetrics remembers an unanalyzable file and keeps its LOC on the next scan', async () => {
  await withTempDir('lattice-scan-metrics-memo-', async (dir) => {
    // A "minified" file: LOC is counted but the content is dropped, so the
    // analyzer never produces metrics for it. The second scan must not
    // re-attempt it (no cache entry exists to hit) and must still report loc.
    const file = path.join(dir, 'bundle.min.js');
    await fs.writeFile(file, 'x'.repeat(200_000));
    const first = await computeFileMetrics([file]);
    assert.equal(first[0].loc, 1);
    assert.equal(first[0].healthDetails, undefined);
    const second = await computeFileMetrics([file]);
    assert.equal(second[0].loc, 1);
    assert.equal(second[0].healthDetails, undefined);
    // Editing the file invalidates the memo: it is analyzed again.
    await fs.writeFile(file, 'export const a = 1;\nexport const b = 2;\n');
    const third = await computeFileMetrics([file]);
    assert.equal(third[0].loc, 2);
    assert.ok(third[0].healthDetails, 'a now-ordinary file is analyzed');
  });
});
