import { test } from 'node:test';
import assert from 'node:assert/strict';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearProjectIdentityCaches, physicalProjectPath } from '../projectIdentity.js';

// A failed realpath is memoized for the rest of the current event-loop turn
// only. That collapses the synchronous per-task storm in /api/tasks for a
// deleted / moved project (500 tasks → 500 blocking failed syscalls + thrown
// Errors per request) into one syscall, while a project created a moment
// later (next turn) still resolves physically — the existing
// "nonexistent paths are not negatively cached" contract.

test('a missing path is probed once per turn, and again on the next turn', async (t) => {
  clearProjectIdentityCaches();
  const missing = path.join(os.tmpdir(), `lattice-missing-${process.pid}-${Date.now()}`);
  const real = syncFs.realpathSync.native;
  let probes = 0;
  t.mock.method(syncFs.realpathSync, 'native', (...args: Parameters<typeof real>) => { probes += 1; return real(...args); });
  for (let i = 0; i < 500; i++) assert.equal(physicalProjectPath(missing), path.resolve(missing).replace(/^[a-z]:/, (d) => d.toUpperCase()));
  assert.equal(probes, 1, 'one syscall per turn for a missing path');
  await new Promise((r) => setImmediate(r));
  physicalProjectPath(missing);
  assert.equal(probes, 2, 'the memo does not outlive the turn');
  clearProjectIdentityCaches();
});
