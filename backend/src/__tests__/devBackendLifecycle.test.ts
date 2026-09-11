import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackendLifecycle, shutdownTerminalServer } from '../../scripts/dev/backendLifecycle.mjs';

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
