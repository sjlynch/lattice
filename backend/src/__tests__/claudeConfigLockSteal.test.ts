import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withClaudeConfigLock } from '../claudeTrust/configLock.js';

// Compatibility with legacy directory owners at the one unchanged mutex path.
// An empty legacy directory has no PID metadata: elapsed time cannot prove its
// writer died, so a new writer must preserve it and wait for its real release.

// Shrunk delays so the normal backoff + steal windows exhaust in milliseconds.
const FAST = { retryDelays: [1, 1], stealRetryDelays: [1, 1] } as const;

async function fixtureDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `lattice-configlock-${label}-`));
}

test('an empty legacy lock directory is preserved because its owner cannot be verified', async () => {
  const dir = await fixtureDir('stale');
  const lockDir = path.join(dir, 'lock');
  try {
    // This might be an orphan OR a slow live legacy writer. There is no safe
    // way to distinguish those cases from the empty directory alone.
    await fs.mkdir(lockDir);
    let ran = false;
    await assert.rejects(() => withClaudeConfigLock(
      async () => {
        ran = true;
        return 'did-work';
      },
      { lockDir, ...FAST },
    ), /legacy directory has no verifiable owner/);
    assert.equal(ran, false);
    assert.equal((await fs.stat(lockDir)).isDirectory(), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('steal does NOT run fn and does NOT remove a lock held throughout the steal window', async () => {
  const dir = await fixtureDir('held');
  const lockDir = path.join(dir, 'lock');
  try {
    // Simulate a legitimate holder that keeps the lock for the whole steal
    // window. A held lock dir is non-empty here (the holder's marker), so the
    // steal's `rmdir` can't remove it — mkdir keeps hitting EEXIST exactly as
    // it would against a caller that currently owns the lock.
    await fs.mkdir(lockDir);
    const marker = path.join(lockDir, 'holder.marker');
    await fs.writeFile(marker, 'held-by-another-caller');

    let ran = false;
    await assert.rejects(
      () =>
        withClaudeConfigLock(
          async () => {
            ran = true;
            return 'should-not-run';
          },
          { lockDir, ...FAST },
        ),
      /could not acquire/i,
    );

    // The core invariant: the stealer never touched fn() …
    assert.equal(ran, false);
    // … and never deleted the holder's lock (the marker — and the dir — survive).
    assert.equal(await fs.readFile(marker, 'utf8'), 'held-by-another-caller');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a contended lock that frees up is acquired without stealing', async () => {
  const dir = await fixtureDir('contended');
  const lockDir = path.join(dir, 'lock');
  try {
    // Hold the lock briefly, then release it within the normal backoff window.
    await fs.mkdir(lockDir);
    const release = (async () => {
      await new Promise((r) => setTimeout(r, 2));
      await fs.rmdir(lockDir);
    })();

    let ran = false;
    const result = await withClaudeConfigLock(
      async () => {
        ran = true;
        return 'ok';
      },
      // Generous backoff so the acquisition happens on the normal path, not via
      // the steal — the lock frees up before the retries run out.
      { lockDir, retryDelays: [5, 5, 5, 5, 5, 5], stealRetryDelays: [1, 1] },
    );
    await release;
    assert.equal(ran, true);
    assert.equal(result, 'ok');
    await assert.rejects(() => fs.stat(lockDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
