// installPiCompletionExtension writes the extension via temp + rename (a torn
// file would be a Pi session with no completion backstop) and leaves no temp
// behind — Pi auto-loads every `.ts` under `.pi/extensions/`, so the directory
// must hold exactly the extension after an install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installPiCompletionExtension, renderPiCompletionExtension } from '../piExtension.js';

test('installPiCompletionExtension writes the rendered extension and leaves no temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-piext-'));
  try {
    const args = {
      dir,
      callbackUrl: 'http://127.0.0.1:5184/api/tasks/t1/complete',
      site: 'task-complete' as const,
      respectQuitGate: true,
    };
    const { extensionFile, sentinelFile } = await installPiCompletionExtension(args);
    const written = await fs.readFile(extensionFile, 'utf8');
    assert.equal(
      written,
      renderPiCompletionExtension({ ...args, extensionFile, sentinelFile }),
    );
    // Idempotent re-install.
    await installPiCompletionExtension(args);
    const names = await fs.readdir(path.dirname(extensionFile));
    assert.deepEqual(names, [path.basename(extensionFile)]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
