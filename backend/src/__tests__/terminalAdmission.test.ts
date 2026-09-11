import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { registerTerminalRoutes } from '../terminalServer/routes.js';
import { createSessionHandler } from '../terminalServer/createSessionHandler.js';
import { createTerminalAdmission } from '../terminalServer/admission.js';
import { attachTerminalWebSocketUpgrade, createTerminalWebSocketServer } from '../terminalServer/websocket.js';
import { TERMINAL_SERVER_AUTH_HEADER } from '../terminalServerAuth.js';

const headers = { 'Content-Type': 'application/json', [TERMINAL_SERVER_AUTH_HEADER]: 'fixture-token' };
const identity = () => ({ requestId: 'request-fixture-0001', requestTimestamp: Date.now(), serverInstanceId: 'executor' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture(options: { live?: number; waitForConfig?: Promise<void>; configEntered?: () => void } = {}) {
  const app = express();
  const admission = createTerminalAdmission();
  let allocations = 0;
  let shutdowns = 0;
  registerTerminalRoutes(app, {
    fingerprint: 'fixture', authToken: 'fixture-token', instanceId: 'executor', admission,
    sessionCount: () => options.live ?? allocations,
    shutdown: async () => { shutdowns++; },
    sessionHandler: createSessionHandler({
      applyClaudeProjectConfig: async () => { options.configEntered?.(); await options.waitForConfig; },
      precreateSession: () => ({ id: `allocated-${++allocations}` }),
    }),
  });
  const server = http.createServer(app);
  const wss = createTerminalWebSocketServer(admission);
  attachTerminalWebSocketUpgrade(server, wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    base, post, allocations: () => allocations, shutdowns: () => shutdowns,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('concurrent duplicate creates run config and allocate only once', async () => {
  const config = deferred();
  const entered = deferred();
  const f = await fixture({ waitForConfig: config.promise, configEntered: entered.resolve });
  const body = { ...identity(), cwd: 'fixture', initialCommand: 'claude' };
  try {
    const first = f.post('/sessions', body);
    await entered.promise;
    const second = f.post('/sessions', body);
    config.resolve();
    const responses = await Promise.all([first, second]);
    for (const response of responses) assert.deepEqual(await response.json(), { id: 'allocated-1' });
    assert.equal(f.allocations(), 1);
    const different = await f.post('/sessions', { ...body, cwd: 'different' });
    assert.equal(different.status, 500);
    assert.match(JSON.stringify(await different.json()), /different options/);
    assert.equal(f.allocations(), 1);
  } finally { config.resolve(); await f.close(); }
});

test('idle upgrade refuses a live executor without closing new admission', async () => {
  const f = await fixture({ live: 1 });
  try {
    const upgrade = await f.post('/shutdown-if-idle', { instanceId: 'executor' });
    assert.equal(upgrade.status, 409);
    assert.equal(f.shutdowns(), 0);
    assert.equal((await f.post('/sessions', identity())).status, 200);
  } finally { await f.close(); }
});

test('disconnected pending create still blocks idle upgrade until allocation finishes', async () => {
  const config = deferred();
  const entered = deferred();
  const f = await fixture({ waitForConfig: config.promise, configEntered: entered.resolve });
  const controller = new AbortController();
  const body = { ...identity(), cwd: 'fixture', initialCommand: 'claude' };
  try {
    const request = fetch(`${f.base}/sessions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify(body),
    });
    await entered.promise;
    controller.abort();
    await assert.rejects(request);
    const upgrade = await f.post('/shutdown-if-idle', { instanceId: 'executor' });
    assert.equal(upgrade.status, 409, 'disconnected config write still owns admission');
    config.resolve();
    const replay = await f.post('/sessions', body);
    assert.deepEqual(await replay.json(), { id: 'allocated-1' });
    assert.equal(f.allocations(), 1);
    assert.equal(f.shutdowns(), 0);
  } finally { config.resolve(); await f.close(); }
});

test('accepted idle upgrade fences both later HTTP and WebSocket creates', async () => {
  const f = await fixture();
  try {
    const upgrade = await f.post('/shutdown-if-idle', { instanceId: 'executor' });
    assert.equal(upgrade.status, 202);
    assert.equal((await f.post('/sessions', identity())).status, 503);
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/ws/terminal');
    const message = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(String(data)));
      ws.once('error', reject);
    });
    assert.match(message, /upgrading/);
    ws.terminate();
    assert.equal(f.allocations(), 0);
    assert.equal(f.shutdowns(), 1);
  } finally { await f.close(); }
});

test('replacement instance rejects a stale create and idle-shutdown request', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/sessions', { ...identity(), serverInstanceId: 'previous' })).status, 409);
    assert.equal((await f.post('/shutdown-if-idle', { instanceId: 'previous' })).status, 409);
    assert.equal(f.allocations(), 0);
    assert.equal(f.shutdowns(), 0);
    assert.equal((await f.post('/sessions', identity())).status, 200);
  } finally { await f.close(); }
});

test('idle-shutdown capability is authenticated before it can close admission', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/shutdown-if-idle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: 'executor' }),
    });
    assert.equal(response.status, 401);
    assert.equal((await f.post('/sessions', identity())).status, 200);
    assert.equal(f.shutdowns(), 0);
  } finally { await f.close(); }
});
