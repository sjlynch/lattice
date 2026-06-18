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
