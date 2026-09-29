import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { killTree, startChild, KILL_GRACE_MS } from '../../../scripts/orchestrate/children.mjs';

// Regression for: on Ctrl+C the orchestrator `taskkill /F /T`'d the backend
// tree at once, while backend/scripts/dev.mjs — which received the same
// console break — was still awaiting its terminal-server `/shutdown` POST.
// The `/F` landed first and orphaned the detached terminal-server with every
// pty inside it. `killTree` on win32 now waits for the child's own exit
// (bounded) before forcing.

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kills: string[];
  kill(sig?: NodeJS.Signals | number): boolean;
};

function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    kills: [] as string[],
    kill(sig?: NodeJS.Signals | number) { child.kills.push(String(sig ?? '')); return true; },
  });
  return child;
}

function taskkillSpy() {
  const calls: { cmd: string; args: string[] }[] = [];
  const options: Record<string, unknown>[] = [];
  const spawnProcess = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args });
    options.push(opts);
    return new EventEmitter();
  }) as unknown as typeof spawn;
  return { calls, options, spawnProcess };
}

test('KILL_GRACE_MS exceeds the dev runner terminal-server shutdown cap (2.5 s)', () => {
  assert.ok(KILL_GRACE_MS > 2500);
});

test('killTree (win32) lets a child that exits within the grace period go without taskkill', async () => {
  const child = fakeChild();
  const { calls, spawnProcess } = taskkillSpy();
  const done = killTree(child, 'SIGINT', { graceMs: 500, platform: 'win32', spawnProcess });
  let settled = false;
  void done.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'must wait for the child while it is still running');
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await done;
  assert.deepEqual(calls, [], 'the runner shut itself down — no force-kill');
  assert.deepEqual(child.kills, [], 'no signal is sent to a .cmd shim (it would not reach the tree anyway)');
});

test('killTree (win32) falls back to taskkill /F /T once the grace period lapses', async () => {
  const child = fakeChild();
  const { calls, spawnProcess } = taskkillSpy();
  const started = Date.now();
  await killTree(child, 'SIGTERM', { graceMs: 30, platform: 'win32', spawnProcess });
  assert.ok(Date.now() - started >= 25, 'waited for the grace period first');
  assert.deepEqual(calls, [{ cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
});

// Regression (2026-09-29): after Ctrl+C the npm.cmd batch shell sat at
// "Terminate batch job (Y/N)?" reading its stdin pipe, and the taskkill meant
// to clear it was itself killed by the user's repeated Ctrl+C. Both shells and
// the orchestrator survived for days, stealing lines from the console.
test('killTree (win32) ends the child stdin so a "Terminate batch job?" prompt reads EOF', async () => {
  const ended: boolean[] = [];
  const child = Object.assign(fakeChild(), { stdin: { end: () => ended.push(true) } });
  const { spawnProcess } = taskkillSpy();
  const done = killTree(child, 'SIGINT', { graceMs: 500, platform: 'win32', spawnProcess });
  assert.deepEqual(ended, [true], 'stdin is ended at once, not after the grace period');
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await done;
});

test('killTree (win32) runs taskkill detached from the console, out of reach of a repeated Ctrl+C', async () => {
  const { options, spawnProcess } = taskkillSpy();
  await killTree(fakeChild(), 'SIGINT', { graceMs: 10, platform: 'win32', spawnProcess });
  assert.equal(options[0]?.detached, true);
});

test('killTree resolves immediately for a child that already exited', async () => {
  const child = fakeChild();
  child.exitCode = 1;
  const { calls, spawnProcess } = taskkillSpy();
  await killTree(child, 'SIGTERM', { graceMs: 10_000, platform: 'win32', spawnProcess });
  assert.deepEqual(calls, []);
  await killTree(null, 'SIGTERM', { graceMs: 10_000, platform: 'win32', spawnProcess });
});

test('killTree resolves immediately for a child that already died by a signal', async () => {
  const child = Object.assign(fakeChild(), { signalCode: 'SIGTERM' as NodeJS.Signals });
  const { calls, spawnProcess } = taskkillSpy();
  await killTree(child, 'SIGTERM', { graceMs: 10_000, platform: 'win32', spawnProcess });
  assert.deepEqual(calls, [], 'no taskkill against a PID that has already exited');
});

test('killTree (POSIX) signals the child directly', async () => {
  const child = fakeChild();
  const { calls, spawnProcess } = taskkillSpy();
  await killTree(child, 'SIGTERM', { graceMs: 10_000, platform: 'linux', spawnProcess });
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(calls, []);
});

test(
  'startChild refuses to shell-join anything but bare npm script names',
  // The validation guards the win32 one-string shell launch; elsewhere
  // startChild would spawn a real npm, which a unit test must not do.
  { skip: process.platform !== 'win32' ? 'win32-only shell-join path' : false },
  () => {
    assert.throws(() => startChild('x', '', ['run', 'dev && echo pwned']), /refusing to shell-join/);
    assert.throws(() => startChild('x', '', ['run', 'dev;']), /refusing to shell-join/);
    assert.throws(() => startChild('x', '', ['run', 'dev dev']), /refusing to shell-join/);
  },
);
