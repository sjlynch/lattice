// spawnWithTimeout: a timeout must take down the WHOLE tree behind a
// `shell: true` spawn. `child.kill()` only reaches the shell (cmd.exe / sh);
// the real work (`pi`, `npm install`) is its grandchild, which used to survive
// the timeout holding the stdio pipes. The grandchild prints its own pid so
// the test can ask the OS whether it is still there afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWithTimeout } from '../spawnWithTimeout.js';

// A node one-liner that reports its pid and then idles forever. No quotes
// inside, so it survives both cmd.exe and sh when spawned through a shell.
const IDLE_SCRIPT = 'process.stdout.write(String(process.pid));setInterval(()=>{},1000)';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Tree kills are fire-and-forget (taskkill on win32), so give the OS a moment.
async function waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test('timeout kills the grandchild behind a shell wrapper, not just the shell', async () => {
  const r = await spawnWithTimeout(`"${process.execPath}"`, ['-e', `"${IDLE_SCRIPT}"`], {
    shell: true,
    timeoutMs: 1500,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  const pid = Number.parseInt(r.stdout.trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `grandchild pid not captured: ${JSON.stringify(r.stdout)}`);
  const dead = await waitForDeath(pid, 5000);
  if (!dead) {
    // Don't leak an idle node process if the assertion is about to fail.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone after all */
    }
  }
  assert.equal(dead, true, `grandchild ${pid} survived the timeout`);
});

test('abort kills the grandchild behind a shell wrapper too', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 800);
  const r = await spawnWithTimeout(`"${process.execPath}"`, ['-e', `"${IDLE_SCRIPT}"`], {
    shell: true,
    timeoutMs: 30_000,
    signal: ac.signal,
  });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  const pid = Number.parseInt(r.stdout.trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `grandchild pid not captured: ${JSON.stringify(r.stdout)}`);
  const dead = await waitForDeath(pid, 5000);
  if (!dead) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone after all */
    }
  }
  assert.equal(dead, true, `grandchild ${pid} survived the abort`);
});

test('a non-shell spawn keeps the plain child.kill() timeout contract', async () => {
  const r = await spawnWithTimeout(process.execPath, ['-e', IDLE_SCRIPT], {
    shell: false,
    timeoutMs: 1000,
  });
  assert.equal(r.timedOut, true);
  const pid = Number.parseInt(r.stdout.trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(await waitForDeath(pid, 5000), true);
});
