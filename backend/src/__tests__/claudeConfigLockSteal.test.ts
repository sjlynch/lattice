import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withClaudeConfigLock } from '../claudeTrust/configLock.js';

// `withClaudeConfigLock` is the mkdir mutex serializing read-modify-write of
// ~/.claude.json. After the normal backoff is exhausted it STEALS a presumed-
// crashed holder's dir. The bug these tests pin: the old steal swallowed the
// EEXIST you get when ANOTHER caller actually holds the lock, then ran fn()
// against that live holder anyway and deleted the holder's dir in its finally —
// collapsing the mutex and reintroducing the lost-update it exists to prevent.

// Shrunk delays so the normal backoff + steal windows exhaust in milliseconds.
const FAST = { retryDelays: [1, 1], stealRetryDelays: [1, 1] } as const;

async function fixtureDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `lattice-configlock-${label}-`));
}

test('steal acquires and runs fn when the lock dir is genuinely abandoned', async () => {
  const dir = await fixtureDir('stale');
  const lockDir = path.join(dir, 'lock');
  try {
    // An empty, removable dir with no live holder = a crashed writer's leftover.
    await fs.mkdir(lockDir);
    let ran = false;
    const result = await withClaudeConfigLock(
      async () => {
        ran = true;
        return 'did-work';
      },
      { lockDir, ...FAST },
    );
    assert.equal(ran, true);
    assert.equal(result, 'did-work');
    // The lock the steal created is released afterwards.
    await assert.rejects(() => fs.stat(lockDir), { code: 'ENOENT' });
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
