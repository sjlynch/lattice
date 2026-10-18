// The editor split uses the graph scanner's ignores/file list, with the shared
// project guard and a strict count boundary. No graph analysis or git exec.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { buildScanRouter } from '../routes/health/scan.js';
import { collectSourceFiles } from '../scanner/collectSourceTree.js';
import { loadGitignore } from '../scanner/ignore.js';
import { partitionSourceAreas } from '../shared/sourceAreas.js';
import { withTempDir, writeLayout } from './helpers/tempDir.js';

test('source-areas validates project/count and partitions the same scanner file list', async () => {
  await withTempDir('lattice-source-areas-', async (project) => {
    await writeLayout(project, {
      '.gitignore': 'ignored/\n', '.git/info/exclude': 'local-only/\n',
      'ignored/main.ts': '', 'local-only/main.ts': '', 'node_modules/main.ts': '',
      'tests/test.ts': '', 'src/types.d.ts': '', 'src/main.spec.ts': '',
      'docs/readme.md': '', 'assets/style.css': '',
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i < 6 ? 'backend' : 'frontend'}/src/file${i}.ts`, ''])),
    });
    const app = express();
    app.use(buildScanRouter(project));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/source-areas`;
    try {
      for (const query of ['', '?project=relative&count=8', '?project=C%3Adrive-relative&count=8']) {
        const response = await fetch(base + query);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /project|absolute/i);
      }
      const url = `${base}?project=${encodeURIComponent(project)}`;
      for (const count of ['', '1', '17', '-2', '2.5', 'NaN', 'abc', '8&count=10', '8&count[x]=10']) {
        const response = await fetch(`${url}&count=${count}`);
        assert.equal(response.status, 400, count);
        assert.deepEqual(await response.json(), { error: 'count must be an integer from 2 to 16' });
      }
      assert.equal((await fetch(url)).status, 400);
      const scanned = (await collectSourceFiles(project, await loadGitignore(project))).map((file) => path.relative(project, file));
      for (const count of [2, 8, 16]) {
        const response = await fetch(`${url}&count=${count}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { areas: partitionSourceAreas(scanned, count), totalFiles: 12 });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
