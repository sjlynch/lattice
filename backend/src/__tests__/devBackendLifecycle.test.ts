import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BACKEND_PORT,
  BOOT_DEATH_WINDOW_MS,
  createBackendLifecycle,
  portHeldHint,
  shutdownTerminalServer,
} from '../../scripts/dev/backendLifecycle.mjs';

function fixture() {
  let shuttingDown = false;
  const children: (EventEmitter & { pid: number; kill(): boolean })[] = [];
  const shutdownExits: number[] = [];
  const lifecycle = createBackendLifecycle({
    copyAssetsBeforeRespawn() {},
    isShuttingDown: () => shuttingDown,
    onExitDuringShutdown: (code) => { shutdownExits.push(code); },
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { pid: 987654 + children.length, kill: () => true });
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
    // Never probe the real port from a unit test (a live dev backend answers).
    probePort: async () => false,
  });
  return { lifecycle, children, shutdownExits, shutdown: () => { shuttingDown = true; } };
}

test('shutdown during a pending dev restart never spawns another backend', () => {
  const f = fixture();
  f.lifecycle.start();
  assert.equal(f.lifecycle.restartBackend('test rebuild'), true);
  f.shutdown();
  f.lifecycle.kill();
  f.children[0].emit('exit', 1, null);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.shutdownExits, [1]);
  assert.equal(f.lifecycle.restartBackend('late watcher event'), false);
});

test('backend spawn error is contained and a later rebuild can retry', () => {
  const f = fixture();
  f.lifecycle.start();
  assert.doesNotThrow(() => f.children[0].emit('error', new Error('spawn EAGAIN')));
  assert.equal(f.lifecycle.restartBackend('retry after spawn failure'), true);
  assert.equal(f.children.length, 2);
});

test('failed kill does not forget a backend that may still be serving', () => {
  const f = fixture();
  f.lifecycle.start();
  f.children[0].emit('spawn');
  assert.doesNotThrow(() => f.children[0].emit('error', new Error('kill EPERM')));
  assert.equal(f.lifecycle.restartBackend('retry kill'), true);
  assert.equal(f.children.length, 1, 'the existing child must still be tracked');
});

test('unexpected exit -1 preserves the last console mirror', async () => {
  const f = fixture();
  f.lifecycle.start();
  const file = path.join(os.homedir(), '.lattice', 'logs', `live-backend-${f.children[0].pid}.log`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'last recovery output');
  try {
    f.children[0].emit('exit', 4294967295, null);
    assert.equal(await fs.readFile(file, 'utf8'), 'last recovery output');
  } finally {
    await fs.unlink(file);
  }
});

test('dev shutdown authenticates with the persisted terminal token', async (t) => {
  const file = path.join(os.homedir(), '.lattice', 'terminalServerToken');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const previous = await fs.readFile(file).catch(() => null);
  const previousEnv = process.env.LATTICE_TERMINAL_TOKEN;
  delete process.env.LATTICE_TERMINAL_TOKEN;
  const token = 'test-terminal-token-'.repeat(3);
  await fs.writeFile(file, `${token}\n`);
  const requests: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  });
  try {
    await shutdownTerminalServer(54321);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:54321/shutdown');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(new Headers(requests[0].init.headers).get('x-lattice-terminal-token'), token);
  } finally {
    if (previousEnv !== undefined) process.env.LATTICE_TERMINAL_TOKEN = previousEnv;
    if (previous) await fs.writeFile(file, previous);
    else await fs.unlink(file);
  }
});

// ---- boot death with the port held --------------------------------------
//
// The backend's stdio is inherited, so this runner never sees its output, and
// a startup EADDRINUSE is a caught error (index.ts → process.exit(1)) that
// writes no crash file. A boot death therefore read exactly like a code crash.
// The runner now probes the port after a boot death and names the cause.

function hintFixture(opts: { probe: boolean | Error; now?: () => number }) {
  let clock = 1_000_000;
  const children: (EventEmitter & { pid: number; kill(): boolean })[] = [];
  const probes: number[] = [];
  const lifecycle = createBackendLifecycle({
    copyAssetsBeforeRespawn() {},
    isShuttingDown: () => false,
    onExitDuringShutdown: () => {},
    spawnProcess: (() => {
      const child = Object.assign(new EventEmitter(), { pid: 555000 + children.length, kill: () => true });
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
    probePort: async (port) => {
      probes.push(port);
      if (opts.probe instanceof Error) throw opts.probe;
      return opts.probe;
    },
    now: opts.now ?? (() => clock),
  });
  return { lifecycle, children, probes, advance: (ms: number) => { clock += ms; } };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

async function devRunnerLog(): Promise<string> {
  assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'refusing to read the real ~/.lattice — run via npm test');
  const file = path.join(os.homedir(), '.lattice', 'logs', 'dev-runner.log');
  return fs.readFile(file, 'utf8').catch(() => '');
}

test('a backend that dies at boot while its port is held gets the port-held hint in the log record', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (msg: unknown) => { errors.push(String(msg)); });
  const f = hintFixture({ probe: true });
  f.lifecycle.start();
  const before = (await devRunnerLog()).length;
  f.advance(2000); // died 2 s after spawn — a boot death
  f.children[0].emit('exit', 1, null);
  await settle();
  assert.deepEqual(f.probes, [BACKEND_PORT]);
  const hint = portHeldHint(BACKEND_PORT);
  assert.match(hint, /port \d+ is held by another process — find it with `/);
  assert.ok(errors.some((e) => e.includes(hint)), `console names the cause: ${errors.join(' | ')}`);
  const record = (await devRunnerLog()).slice(before);
  assert.match(record, /\[lattice-backend\] exited code=1 — /);
  assert.ok(record.includes(hint), `dev-runner.log record carries the hint: ${record}`);
  assert.equal(f.lifecycle.needsStart(), true, 'the dead child is forgotten so the next rebuild can retry');
});

test('a boot death with the port free, and a mid-flight death, record no port hint', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (msg: unknown) => { errors.push(String(msg)); });
  const free = hintFixture({ probe: false });
  free.lifecycle.start();
  free.advance(1000);
  free.children[0].emit('exit', 1, null);
  await settle();
  assert.deepEqual(free.probes, [BACKEND_PORT], 'a boot death is probed');

  const late = hintFixture({ probe: true });
  late.lifecycle.start();
  late.advance(BOOT_DEATH_WINDOW_MS + 1);
  late.children[0].emit('exit', 1, null);
  await settle();
  assert.deepEqual(late.probes, [], 'a death after the boot window is not a port problem — no probe');

  const clean = hintFixture({ probe: true });
  clean.lifecycle.start();
  clean.children[0].emit('exit', 0, null);
  await settle();
  assert.deepEqual(clean.probes, [], 'a clean exit is never probed');

  assert.ok(!errors.some((e) => e.includes('is held by another process')), errors.join(' | '));
  assert.equal(errors.filter((e) => e.includes('dist/index.js exited')).length, 3, 'every death is still recorded');
});

test('a failing port probe still records the exit', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (msg: unknown) => { errors.push(String(msg)); });
  const f = hintFixture({ probe: new Error('probe blew up') });
  f.lifecycle.start();
  f.children[0].emit('exit', 1, null);
  await settle();
  assert.equal(errors.filter((e) => e.includes('dist/index.js exited')).length, 1);
});
