import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust.js';
import { withTempDir } from './helpers/tempDir.js';

test('concurrent atomic writes in the same millisecond use independent temporary files', async (t) => {
  await withTempDir('lattice-atomic-concurrent-', async (dir) => {
    t.mock.method(Date, 'now', () => 123456789);
    const file = path.join(dir, 'target.json');
    const bodies = Array.from({ length: 12 }, (_, i) => JSON.stringify({ i, text: 'x'.repeat(1000 + i) }));
    const results = await Promise.allSettled(bodies.map((body) => atomicWriteFile(file, body)));
    assert.deepEqual(results.filter((result) => result.status === 'rejected'), []);
    assert.ok(bodies.includes(await fs.readFile(file, 'utf8')), 'the final file must contain one complete write');
    assert.deepEqual(await tempFiles(dir), []);
  });
});

// `atomicWriteFile` is the shared temp→rename writer behind every
// ~/.claude.json / mcpSecrets.json write. The bug it fixes: a failed rename
// (routine on Windows when another Claude has the file open) used to orphan
// the `.lattice-*.tmp`, piling up ~8MB of dead temps. These pin both the happy
// path AND the cleanup-on-failure contract.

async function tempFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((n) => n.includes('.lattice-') && n.endsWith('.tmp'));
}

test('atomicWriteFile writes the content and leaves no temp behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-atomicwrite-'));
  try {
    const file = path.join(dir, 'target.json');
    await atomicWriteFile(file, '{"a":1}');
    assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}');
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFile overwrites an existing file atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-atomicwrite-ovr-'));
  try {
    const file = path.join(dir, 'target.json');
    await atomicWriteFile(file, 'first');
    await atomicWriteFile(file, 'second');
    assert.equal(await fs.readFile(file, 'utf8'), 'second');
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFile cleans up its temp when the rename fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-atomicwrite-fail-'));
  try {
    // Target path is an existing *directory*, so renaming the temp file onto
    // it can never succeed (EPERM/EACCES/EISDIR depending on platform). The
    // writer must reject AND remove the temp it created.
    const target = path.join(dir, 'subdir');
    await fs.mkdir(target);
    await assert.rejects(() => atomicWriteFile(target, 'x'));
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
