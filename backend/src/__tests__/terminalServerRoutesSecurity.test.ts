import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';
import { registerTerminalRoutes } from '../terminalServer/routes.js';
import { TERMINAL_SERVER_AUTH_HEADER } from '../terminalServerAuth.js';

const AUTH_TOKEN = 'test-terminal-token-1234567890abcdef';

type Harness = {
  port: number;
  sessionCalls: () => number;
  shutdownCalls: () => number;
  close: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
  const app = express();
  let sessionCallCount = 0;
  let shutdownCallCount = 0;
  const sessionHandler: RequestHandler = (_req, res) => {
    sessionCallCount += 1;
    res.json({ id: 'pty_test' });
  };

  registerTerminalRoutes(app, {
    fingerprint: 'test-fingerprint',
    authToken: AUTH_TOKEN,
    sessionHandler,
    shutdown: async () => {
      shutdownCallCount += 1;
    },
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    sessionCalls: () => sessionCallCount,
    shutdownCalls: () => shutdownCallCount,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function url(h: Harness, path: string): string {
  return `http://127.0.0.1:${h.port}${path}`;
}

function authHeaders(): Record<string, string> {
  return { [TERMINAL_SERVER_AUTH_HEADER]: AUTH_TOKEN };
}

test('terminal-server HTTP rejects evil-origin /shutdown without calling shutdown', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(url(h, '/shutdown'), {
      method: 'POST',
      headers: { ...authHeaders(), Origin: 'http://evil.com' },
    });
    assert.equal(res.status, 403);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.shutdownCalls(), 0, 'shutdown() must not run');
  } finally {
    await h.close();
  }
});

test('terminal-server HTTP rejects evil-origin /sessions without calling precreate', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(url(h, '/sessions'), {
      method: 'POST',
      headers: {
        ...authHeaders(),
        Origin: 'http://evil.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.equal(res.status, 403);
    assert.equal(h.sessionCalls(), 0, 'precreateSession() must not run');
  } finally {
    await h.close();
  }
});

test('terminal-server HTTP rejects missing-token mutation requests', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(url(h, '/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.equal(res.status, 401);
    assert.equal(h.sessionCalls(), 0, 'precreateSession() must not run');
  } finally {
    await h.close();
  }
});

test('terminal-server HTTP allows token-bearing backend /sessions and /shutdown', async () => {
  const h = await startHarness();
  try {
    const createRes = await fetch(url(h, '/sessions'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.equal(createRes.status, 200);
    assert.deepEqual(await createRes.json(), { id: 'pty_test' });
    assert.equal(h.sessionCalls(), 1);

    const shutdownRes = await fetch(url(h, '/shutdown'), {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(shutdownRes.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.shutdownCalls(), 1);
  } finally {
    await h.close();
  }
});
