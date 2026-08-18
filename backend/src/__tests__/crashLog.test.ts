// crashLog is the only record a backend or terminal-server death leaves behind:
// the backend's output lives in the user's own `npm run dev` console, and the
// terminal-server is spawned with stdio:'ignore' so its output goes nowhere at
// all. These pin the properties that make a crash file worth having — it lands
// on disk, it carries the log lines leading up to the crash, and a crash loop
// can't fill the disk with them.
//
// installCrashLogging() itself is not exercised here: it patches the global
// console and registers process-level handlers, which would leak into every
// other test in the runner. The pieces it composes are what's tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { crashLogDir, noteCrashContext, writeCrashLog } from '../crashLog.js';

// The suite runs with a redirected home (see helpers/isolateHome.mjs), so this
// resolves inside a throwaway temp dir.
async function crashFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(crashLogDir())).filter((f) => f.startsWith('crash-'));
  } catch {
    return [];
  }
}

test('writeCrashLog persists the error and the preceding log context', async () => {
  noteCrashContext('[test] a breadcrumb before the crash');
  const err = new Error('boom in the watcher');

  const file = writeCrashLog('uncaughtException', err);
  assert.ok(file, 'expected a crash file path');

  const body = await fs.readFile(file as string, 'utf8');
  assert.match(body, /kind:\s+uncaughtException/);
  assert.match(body, /boom in the watcher/);
  assert.match(body, /a breadcrumb before the crash/, 'log context must be included');
  assert.match(body, /node:\s+v/, 'runtime details must be included');
});

test('writeCrashLog captures non-Error rejection reasons', async () => {
  const file = writeCrashLog('unhandledRejection', { code: 'EPERM', why: 'no stack here' });
  assert.ok(file);
  const body = await fs.readFile(file as string, 'utf8');
  assert.match(body, /no stack here/);
});

test('crash files are capped so a crash loop cannot fill the disk', async () => {
  // Well past the retention limit; each write prunes the oldest. Same-
  // millisecond writes must still produce distinct files, which is what a real
  // crash loop looks like.
  const written = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const file = writeCrashLog('loop', new Error(`crash ${i}`));
    assert.ok(file);
    written.add(file as string);
  }
  assert.equal(written.size, 30, 'every crash must get its own file');
  const files = await crashFiles();
  assert.ok(files.length <= 20, `expected at most 20 retained crash files, got ${files.length}`);
  assert.ok(files.length > 0, 'retention must not delete everything');
});

test('crash logs live under the home-scoped lattice dir, never in a project', async () => {
  const dir = crashLogDir();
  assert.equal(path.basename(dir), 'logs');
  assert.equal(path.basename(path.dirname(dir)), '.lattice');
});
