// Regression: installCrashLogging registered SIGINT/SIGTERM/SIGHUP listeners
// purely to drop a breadcrumb — and a listener on a signal REMOVES Node's
// default terminate. So a backend with no other listener (before any health
// watcher registers its flush hook; SIGHUP always) ignored Ctrl+C / SIGTERM,
// and a closed terminal left it running and holding :5184.
//
// Runs installCrashLogging in a CHILD process: it patches the global console
// and registers process handlers, which must not leak into the test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const crashLogUrl = pathToFileURL(path.resolve('src/crashLog.ts')).href;

function runChild(body: string): { status: number | null; home: string; stdout: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-signal-home-'));
  const script = path.join(home, 'child.mts');
  fs.writeFileSync(
    script,
    `import { installCrashLogging } from ${JSON.stringify(crashLogUrl)};\n` +
      `installCrashLogging('backend');\n${body}\n`,
  );
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, home, stdout: r.stdout };
}

function crashFiles(home: string): string[] {
  try {
    return fs.readdirSync(path.join(home, '.lattice', 'logs')).filter((f) => f.startsWith('crash-') || f.startsWith('live-'));
  } catch {
    return [];
  }
}

test('a signal with no other listener exits (128+n) instead of being swallowed, and is not a crash', () => {
  const { status, home, stdout } = runChild(
    `process.emit('SIGINT');\n` +
      `setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, 500);`,
  );
  try {
    assert.equal(status, 128 + os.constants.signals.SIGINT, stdout);
    assert.doesNotMatch(stdout, /STILL-ALIVE/);
    assert.deepEqual(crashFiles(home), [], 'an orderly signal exit leaves no crash / live file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a signal another listener owns is left to that listener', () => {
  const { status, home, stdout } = runChild(
    `process.on('SIGTERM', () => { console.log('OWNER-RAN'); setTimeout(() => process.exit(0), 50); });\n` +
      `process.emit('SIGTERM');`,
  );
  try {
    assert.equal(status, 0, stdout);
    assert.match(stdout, /OWNER-RAN/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
