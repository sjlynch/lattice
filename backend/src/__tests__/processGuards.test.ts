import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Regression for: the process-level guards used to `console.error` and return
// for EVERY uncaughtException / unhandledRejection, not just the known
// node-pty Windows cleanup throw. Because installing these handlers disables
// Node's default crash behaviour, a real programming error left the backend
// (or the detached terminal-server) running in an undefined state instead of
// failing fast. These tests spawn a child that imports each guard module and
// assert the fail-fast contract: node-pty cleanup errors are swallowed (the
// process survives), any other error takes the process down non-zero.

const MAIN_GUARD_URL = new URL('../processGuards.ts', import.meta.url).href;
const TERMINAL_GUARD_URL = new URL(
  '../terminalServer/processGuards.ts',
  import.meta.url,
).href;

// Runs in a child node process (under tsx, so it can import the .ts guard
// module). GUARD_URL selects the module, MODE selects which failure to raise
// on a later tick. A swallow-mode child is expected to print STILL-ALIVE and
// exit 0; a crash-mode child is expected to exit non-zero before its 800 ms
// watchdog ever fires.
const CHILD_SOURCE = `
const url = process.env.GUARD_URL;
const mode = process.env.MODE;
(async () => {
  const mod = await import(url);
  const install = mod.installProcessGuards || mod.installTerminalProcessGuards;
  if (typeof install !== 'function') throw new Error('no install export');
  install();
  const isSwallow = mode === 'swallow-throw' || mode === 'swallow-reject';
  const cleanupError = () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'forEach')");
    error.stack = error.toString() + '\\n    at C:/app/node_modules/node-pty/lib/windowsPtyAgent.js:141:32';
    return error;
  };
  setTimeout(() => {
    if (mode === 'swallow-throw') {
      throw cleanupError();
    } else if (mode === 'swallow-reject') {
      Promise.reject(cleanupError());
    } else if (mode === 'crash-pty-throw') {
      const e = cleanupError(); e.message = 'native allocation failed'; throw e;
    } else if (mode === 'crash-pty-reject') {
      Promise.reject('node-pty cleanup failure');
    } else if (mode === 'crash-reject') {
      Promise.reject(new Error('generic backend failure'));
    } else {
      throw new Error('generic backend failure');
    }
  }, 10);
  // Swallow modes: prove we are still alive shortly after. Crash modes: a late
  // watchdog that must NOT be reached if the fix takes the process down.
  setTimeout(() => { console.log('STILL-ALIVE'); process.exit(0); }, isSwallow ? 150 : 800);
})();
`;

function runGuardChild(
  guardUrl: string,
  mode: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '-e', CHILD_SOURCE],
      {
        env: { ...process.env, GUARD_URL: guardUrl, MODE: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('guard child did not exit within 5s'));
    }, 5000);
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
  });
}

for (const guard of [
  { label: 'main', url: MAIN_GUARD_URL },
  { label: 'terminal-server', url: TERMINAL_GUARD_URL },
]) {
  test(`${guard.label} guard swallows a node-pty uncaughtException and stays alive`, async () => {
    const r = await runGuardChild(guard.url, 'swallow-throw');
    assert.match(
      r.stdout,
      /STILL-ALIVE/,
      `expected the process to survive a node-pty error; stderr=${r.stderr}`,
    );
    assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test(`${guard.label} guard swallows a node-pty unhandledRejection and stays alive`, async () => {
    const r = await runGuardChild(guard.url, 'swallow-reject');
    assert.match(
      r.stdout,
      /STILL-ALIVE/,
      `expected the process to survive a node-pty rejection; stderr=${r.stderr}`,
    );
    assert.equal(r.code, 0, `expected exit 0; stderr=${r.stderr}`);
  });

  test(`${guard.label} guard crashes non-zero on a generic uncaughtException`, async () => {
    const r = await runGuardChild(guard.url, 'crash-throw');
    assert.doesNotMatch(
      r.stdout,
      /STILL-ALIVE/,
      'a real programming error must not leave the process running',
    );
    assert.notEqual(r.code, 0, 'a real uncaughtException must exit non-zero');
  });

  test(`${guard.label} guard crashes non-zero on a generic unhandledRejection`, async () => {
    const r = await runGuardChild(guard.url, 'crash-reject');
    assert.doesNotMatch(
      r.stdout,
      /STILL-ALIVE/,
      'a real unhandled rejection must not leave the process running',
    );
    assert.notEqual(r.code, 0, 'a real unhandledRejection must exit non-zero');
  });

  for (const mode of ['crash-pty-throw', 'crash-pty-reject']) {
    test(`${guard.label} guard does not swallow an unrelated node-pty ${mode}`, async () => {
      const r = await runGuardChild(guard.url, mode);
      assert.doesNotMatch(r.stdout, /STILL-ALIVE/);
      assert.notEqual(r.code, 0, 'mentioning node-pty must not bypass fail-fast');
    });
  }
}
