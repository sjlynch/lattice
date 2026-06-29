import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mountBaseMiddleware } from '../server/app.js';
import { buildPiEndpointsRouter } from '../routes/settings/piEndpoints.js';
import { probeEndpointModels } from '../piModels.js';

async function withProbeServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  mountBaseMiddleware(app);
  app.use(buildPiEndpointsRouter());
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('unsafe cross-origin form POST is rejected before Pi endpoint probe fetches', async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.SECRET_TEST_KEY;
  let fetchCalls = 0;
  process.env.SECRET_TEST_KEY = 'super-secret-value';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: [{ id: 'leaked' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await withProbeServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/pi-endpoints/probe`, {
        method: 'POST',
        headers: {
          Origin: 'http://evil.test',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'baseUrl=https%3A%2F%2Fattacker.example%2Fv1&apiKey=SECRET_TEST_KEY',
      });
      assert.equal(res.status, 403);
      assert.equal(fetchCalls, 0, 'route handler must not run the outbound probe');
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.SECRET_TEST_KEY;
    else process.env.SECRET_TEST_KEY = originalSecret;
  }
});

test('Pi endpoint probes do not resolve env-var apiKey hints', async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.SECRET_TEST_KEY;
  let authorization: string | undefined;
  process.env.SECRET_TEST_KEY = 'super-secret-value';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    authorization = headers?.Authorization;
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const models = await probeEndpointModels('https://attacker.example/v1', 'SECRET_TEST_KEY');
    assert.deepEqual(models, ['model-a']);
    assert.equal(authorization, 'Bearer SECRET_TEST_KEY');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.SECRET_TEST_KEY;
    else process.env.SECRET_TEST_KEY = originalSecret;
  }
});

test('Pi endpoint probe accepts JSON only', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await withProbeServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/pi-endpoints/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'baseUrl=https%3A%2F%2Fmodels.example%2Fv1',
      });
      assert.equal(res.status, 415);
      assert.equal(fetchCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
