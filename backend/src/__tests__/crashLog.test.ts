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
import {
  adoptOrphanedLiveLogs,
  crashLogDir,
  noteCrashContext,
  writeCrashLog,
} from '../crashLog.js';

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

// ---------------------------------------------------------------------------
// The record for a death that runs no JavaScript
// ---------------------------------------------------------------------------
//
// Regression for 2026-08-20: the backend exited with 3221225477 (0xC0000005,
// STATUS_ACCESS_VIOLATION) and left NOTHING — no crash file, no report.*.json,
// no dev-runner record. Every other mechanism in crashLog.ts writes from a JS
// handler, and an OS-level kill reaches none of them, so the only way to know
// what the process was doing is a mirror of the ring written BEFORE it died.

async function crashFilesMatching(pattern: RegExp): Promise<string[]> {
  return (await crashFiles()).filter((f) => pattern.test(f));
}

test('a live log left by a dead process is promoted to a crash file with its tail', async () => {
  const dir = crashLogDir();
  await fs.mkdir(dir, { recursive: true });
  // PID 0 is never a live process, so this stands in for "it vanished".
  const orphan = path.join(dir, 'live-backend-0.log');
  await fs.writeFile(orphan, '[merge-run] finalizing task t_123\n[scan] start C:\proj\n', 'utf8');

  adoptOrphanedLiveLogs(dir);

  const adopted = await crashFilesMatching(/-backend-nojs\.log$/);
  assert.equal(adopted.length, 1, 'the orphaned live log must become a crash file');
  const body = await fs.readFile(path.join(dir, adopted[0]), 'utf8');
  assert.match(body, /finalizing task t_123/, 'the tail is the whole point');
  assert.match(body, /without running any JavaScript/, 'it must say why nothing else was written');
  await assert.rejects(fs.stat(orphan), 'the live log is consumed, not left to be re-adopted');
});

test('a live log belonging to a RUNNING process is left alone', async () => {
  // Two Lattice processes can share the logs dir (a backend and a terminal-
  // server, or a second dev server). Adopting a live one would both steal its
  // file and report a crash that never happened.
  const dir = crashLogDir();
  await fs.mkdir(dir, { recursive: true });
  const mine = path.join(dir, `live-backend-${process.pid}.log`);
  await fs.writeFile(mine, 'still running\n', 'utf8');

  adoptOrphanedLiveLogs(dir);

  assert.ok(await fs.stat(mine), 'a live process keeps its own live log');
});

test('a burst of no-JS records cannot evict the richer handler-written crash files', async () => {
  // Anything that force-kills the backend repeatedly (on Windows every dev
  // restart is a TerminateProcess) produces one `-nojs` file per kill. Sharing a
  // retention bucket with the real crash files would let that burst push out the
  // ones that actually carry a stack.
  const dir = crashLogDir();
  await fs.mkdir(dir, { recursive: true });
  const real = writeCrashLog('uncaughtException', new Error('the one that matters'));
  assert.ok(real);

  for (let i = 0; i < 40; i += 1) {
    const orphan = path.join(dir, `live-backend-${1000 + i}.log`);
    await fs.writeFile(orphan, `tail ${i}\n`, 'utf8');
    adoptOrphanedLiveLogs(dir);
  }

  const survivors = await crashFiles();
  assert.ok(
    survivors.includes(path.basename(real as string)),
    'the handler-written crash file must survive a no-JS burst',
  );
  const nojs = survivors.filter((f) => f.endsWith('-nojs.log'));
  assert.ok(nojs.length <= 20, `the no-JS bucket is still capped (got ${nojs.length})`);
});
