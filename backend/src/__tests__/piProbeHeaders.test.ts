// Regression: Detect and capability probes omitted explicitly configured auth
// and tenant headers. Exercise the real manual route and HTTP probe transport,
// including precedence, malformed input, and literal-only credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildPiEndpointsRouter } from '../routes/settings/piEndpoints.js';
import { probeEndpointModels, probeThinkingLevels } from '../piModels/probe.js';

async function withServer<T>(handler: http.RequestListener, fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const EFFORT_ERROR = 'reasoning_effort must be one of low, high, xhigh, max';

test('manual route and thinking probes forward custom auth/tenant headers with case-insensitive precedence', async () => {
  const received: http.IncomingHttpHeaders[] = [];
  await withServer((req, res) => {
    received.push(req.headers);
    if (req.headers['x-api-key'] !== 'literal-secret' || req.headers['x-tenant'] !== 'tenant-a' ||
        req.headers.authorization !== 'Custom final' || req.headers['content-type'] !== 'application/custom+json') {
      res.writeHead(403); res.end(); return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1', max_model_len: 8192 }] }));
    } else {
      req.resume();
      res.writeHead(400); res.end(EFFORT_ERROR);
    }
  }, async (endpoint) => {
    const app = express();
    app.use(express.json());
    app.use(buildPiEndpointsRouter());
    const headers = {
      'X-Api-Key': 'literal-secret', 'X-Tenant': 'tenant-a',
      Authorization: 'Custom first', aUtHoRiZaTiOn: 'Custom final',
      'Content-Type': 'application/first', 'cOnTeNt-TyPe': 'application/custom+json',
    };
    await withServer(app, async (api) => {
      const response = await fetch(`${api}/api/pi-endpoints/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: `${endpoint}/v1`, apiKey: 'default-key', headers }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { models: [{ id: 'm1', contextWindow: 8192 }] });
    });
    assert.deepEqual(await probeThinkingLevels(`${endpoint}/v1`, 'default-key', 'm1', headers),
      ['low', 'high', 'xhigh', 'max']);
    assert.equal(received.length, 2);
    assert.ok(received.every((h) => h.authorization === 'Custom final'), 'no combined Authorization values');
    assert.ok(received.every((h) => h['content-type'] === 'application/custom+json'), 'no combined Content-Type values');
  });
});

test('apiKey-only probes retain bearer auth and capability JSON content type', async () => {
  const received: http.IncomingHttpHeaders[] = [];
  await withServer((req, res) => {
    received.push(req.headers);
    req.resume();
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[{"id":"m1"}]}');
    } else {
      res.writeHead(400); res.end(EFFORT_ERROR);
    }
  }, async (endpoint) => {
    assert.deepEqual(await probeEndpointModels(`${endpoint}/v1`, ' literal-key '), [{ id: 'm1' }]);
    assert.deepEqual(await probeThinkingLevels(`${endpoint}/v1`, ' literal-key ', 'm1'),
      ['low', 'high', 'xhigh', 'max']);
    assert.equal(received[0].authorization, 'Bearer literal-key');
    assert.equal(received[1].authorization, 'Bearer literal-key');
    assert.equal(received[1]['content-type'], 'application/json');
  });
});

test('malformed manual header input is rejected before contacting the endpoint', async () => {
  let requests = 0;
  await withServer((req, res) => { requests++; req.resume(); res.writeHead(200); res.end('{}'); }, async (endpoint) => {
    const app = express();
    app.use(express.json());
    app.use(buildPiEndpointsRouter());
    await withServer(app, async (api) => {
      for (const headers of [null, [], 'text', 123, { 'X-Key': 1 }, { 'Bad Name': 'a' },
        { '': 'a' }, { 'X-Key': 'secret\r\nInjected: yes' }, { 'X-Key': 'bad\u0000value' },
        { Authorization: 123, authorization: 'otherwise-valid' }]) {
        const response = await fetch(`${api}/api/pi-endpoints/probe`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: `${endpoint}/v1`, headers }),
        });
        assert.equal(response.status, 400);
        const error = (await response.json()) as { error: string };
        assert.match(error.error, /headers/i);
        assert.ok(!error.error.includes('secret'), 'validation errors do not echo header values');
      }
    });
    assert.equal(await probeThinkingLevels(`${endpoint}/v1`, undefined, 'm1', { 'Bad Name': 'a' }), null);
    await assert.rejects(probeEndpointModels(`${endpoint}/v1`, undefined, { 'X-Key': 'bad\nvalue' }), /headers/);
    assert.equal(requests, 0);
  });
});

test('probe keys and headers never resolve environment secrets or execute command syntax', async () => {
  const previous = process.env.LATTICE_PI_PROBE_HEADER_TEST;
  process.env.LATTICE_PI_PROBE_HEADER_TEST = 'ambient-secret';
  const received: http.IncomingHttpHeaders[] = [];
  try {
    await withServer((req, res) => {
      received.push(req.headers);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[]}');
    }, async (endpoint) => {
      const headers = { 'X-Env': '${LATTICE_PI_PROBE_HEADER_TEST}', 'X-Command': '!echo command' };
      for (const key of ['$LATTICE_PI_PROBE_HEADER_TEST', '${LATTICE_PI_PROBE_HEADER_TEST}', 'MY_API_KEY']) {
        await probeEndpointModels(`${endpoint}/v1`, key, headers);
        assert.equal(received.at(-1)?.authorization, `Bearer ${key}`);
      }
      await probeEndpointModels(`${endpoint}/v1`, '!echo command', headers);
      assert.equal(received.at(-1)?.authorization, undefined);
      assert.ok(received.every((h) => h['x-env'] === headers['X-Env'] && h['x-command'] === headers['X-Command']));
      assert.ok(received.every((h) => !JSON.stringify(h).includes('ambient-secret')));
    });
  } finally {
    if (previous === undefined) delete process.env.LATTICE_PI_PROBE_HEADER_TEST;
    else process.env.LATTICE_PI_PROBE_HEADER_TEST = previous;
  }
});
