import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ScrollbackStore } from '../terminal/scrollbackStore.js';

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'lattice-scrollback-'));
}

function logPath(dir: string, id: string): string {
  return path.join(dir, `${id}.log`);
}

test('append + replay round-trips small output and dispose removes the log', async () => {
  const dir = await tmpDir();
  const store = new ScrollbackStore('tty_a', { dir });

  store.append('hello\n');
  store.append('world\n');
  assert.equal(store.replay(), 'hello\nworld\n');
  assert.ok(fs.existsSync(logPath(dir, 'tty_a')));

  store.dispose();
  assert.ok(!fs.existsSync(logPath(dir, 'tty_a')));
  assert.equal(store.replay(), '');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('replay before any output returns empty string', async () => {
  const dir = await tmpDir();
  const store = new ScrollbackStore('tty_empty', { dir });
  assert.equal(store.replay(), '');
  assert.equal(store.size, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('replay returns at most the window, ending with the latest output and starting on a line boundary', async () => {
  const dir = await tmpDir();
  const store = new ScrollbackStore('tty_win', {
    dir,
    replayWindowBytes: 100,
    flushThresholdBytes: 16,
    maxDiskBytes: 10_000,
    compactKeepBytes: 10_000,
  });

  let full = '';
  for (let i = 0; i < 50; i++) {
    const line = `line${String(i).padStart(4, '0')}\n`; // 9 bytes each
    store.append(line);
    full += line;
  }

  const replay = store.replay();
  // Bounded by the window.
  assert.ok(replay.length <= 100, `replay ${replay.length} should be <= 100`);
  assert.ok(replay.length > 0);
  // Always a suffix of the full stream (never duplicated/garbled tail).
  assert.ok(full.endsWith(replay));
  // Begins right after a newline (no partial leading line) since it was trimmed.
  const cut = full.length - replay.length;
  assert.ok(cut > 0, 'window should have dropped some history');
  assert.equal(full[cut - 1], '\n');

  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('compaction keeps the on-disk log bounded while preserving recent output', async () => {
  const dir = await tmpDir();
  const id = 'tty_compact';
  const store = new ScrollbackStore(id, {
    dir,
    replayWindowBytes: 100,
    flushThresholdBytes: 16,
    maxDiskBytes: 200,
    compactKeepBytes: 120,
  });

  let lastLine = '';
  for (let i = 0; i < 500; i++) {
    lastLine = `entry${String(i).padStart(5, '0')}\n`; // 11 bytes each (~5.5 KB total)
    store.append(lastLine);
  }
  store.replay(); // forces a final flush
  // Compaction is asynchronous (it must never block the terminal-server's
  // event loop); wait for the rewrite + its post-compaction flush to land.
  await store.settle();

  const size = fs.statSync(logPath(dir, id)).size;
  assert.ok(
    size <= 200,
    `log size ${size} should stay within maxDiskBytes after compaction`,
  );
  // Most-recent output survived compaction.
  assert.ok(store.replay().endsWith(lastLine));

  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('replayAsync during an in-flight compaction includes the held pending exactly once', async () => {
  const dir = await tmpDir();
  const id = 'tty_compact_async';
  const store = new ScrollbackStore(id, {
    dir,
    replayWindowBytes: 100,
    flushThresholdBytes: 16,
    maxDiskBytes: 200,
    compactKeepBytes: 120,
  });
  // Push the log over the cap: the crossing flush kicks off a compaction.
  for (let i = 0; i < 30; i++) store.append(`entry${String(i).padStart(5, '0')}\n`);
  assert.ok(store['compaction'], 'a compaction should be in flight');
  // Output arriving now is held in `pending` until the rewrite lands.
  store.append('held-line\n');
  const replay = await store.replayAsync();
  assert.ok(replay.endsWith('held-line\n'), 'the held output is the newest, so it ends the replay');
  assert.equal(replay.split('held-line').length - 1, 1, 'held output appears exactly once');
  await store.settle();
  const after = store.replay();
  assert.ok(after.endsWith('held-line\n'));
  assert.equal(after.split('held-line').length - 1, 1, 'still once after the rewrite + flush landed');
  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('replayAsync is a snapshot as of the call: output appended during the read is excluded', async () => {
  const dir = await tmpDir();
  const store = new ScrollbackStore('tty_snapshot', {
    dir,
    replayWindowBytes: 10_000,
    flushThresholdBytes: 4, // every append lands on disk immediately
    maxDiskBytes: 1_000_000,
    compactKeepBytes: 1_000_000,
  });
  store.append('before\n');
  const inFlight = store.replayAsync();
  // Lands on disk while the read above is still in flight. An attaching
  // client receives this as a held live frame, so it must NOT be in the replay.
  store.append('after\n');
  assert.equal(await inFlight, 'before\n');
  assert.equal(store.replay(), 'before\nafter\n', 'the next replay sees everything');
  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('multibyte UTF-8 in the replay body is not corrupted across flush boundaries', async () => {
  const dir = await tmpDir();
  const store = new ScrollbackStore('tty_utf8', {
    dir,
    replayWindowBytes: 10_000,
    flushThresholdBytes: 8, // tiny, so flushes land between appends
    maxDiskBytes: 1_000_000,
    compactKeepBytes: 1_000_000,
  });

  const lines = ['café — 日本語\n', 'emoji 🚀🔥\n', 'ascii ok\n'];
  for (const l of lines) store.append(l);

  const replay = store.replay();
  // No replacement characters anywhere in the decoded body.
  assert.ok(!replay.includes('�'));
  for (const l of lines) assert.ok(replay.includes(l), `replay missing ${l}`);

  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('degrades to bounded in-memory replay when the disk path is unusable', async () => {
  const dir = await tmpDir();
  // Make the "directory" a regular file so mkdir/append throw → degraded mode.
  const fileAsDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x');

  const store = new ScrollbackStore('tty_degraded', {
    dir: fileAsDir,
    replayWindowBytes: 10_000,
    flushThresholdBytes: 4, // first append flushes and trips the failure
    maxDiskBytes: 1_000_000,
    compactKeepBytes: 1_000_000,
  });

  store.append('still-here\n');
  store.append('and-this\n');
  const replay = store.replay();
  assert.ok(replay.endsWith('and-this\n'));
  assert.ok(replay.includes('still-here\n'));

  store.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});
