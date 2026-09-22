import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(backendRoot, 'scripts', 'copy-assets.mjs');

// The dev runner re-runs copy-assets before EVERY backend spawn, and its
// fs.watch('dist') restarts the backend on any dist/ write. An unconditional
// copy would therefore restart → copy → restart forever; the script must only
// write when the destination differs from the source. (Runs against the real
// dist/: when it is already in sync — the normal state — nothing is written.)
const assets = [
  ['workflowRuns', 'create-task-template.cjs'],
  ['latticeApiDocs', 'LATTICE_API.template.md'],
  ['latticeApiDocs', 'LATTICE_API_RECIPES.template.md'],
].map((rel) => ({
  from: path.join(backendRoot, 'src', ...rel),
  to: path.join(backendRoot, 'dist', ...rel),
}));

async function mtimes() {
  return Promise.all(assets.map(async (a) => (await fs.stat(a.to)).mtimeMs));
}

test('copy-assets copies every runtime asset into dist/ and is a no-op on a second run', async () => {
  await execFileAsync(process.execPath, [script]);
  for (const a of assets) {
    assert.ok((await fs.readFile(a.to)).equals(await fs.readFile(a.from)), `${a.to} mirrors its source`);
  }
  const first = await mtimes();
  // Make sure a rewrite WOULD be observable before asserting there was none.
  await new Promise((r) => setTimeout(r, 20));
  await execFileAsync(process.execPath, [script]);
  assert.deepEqual(await mtimes(), first, 'an in-sync destination must not be rewritten (mtime unchanged)');
});
