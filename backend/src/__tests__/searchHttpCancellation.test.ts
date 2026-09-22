import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { buildSearchRouter } from '../routes/search.js';
import type { SearchResult } from '../search.js';

// /api/search used to cancel on the REQUEST's `close`, the signal
// routes/health/scan.ts documents as unreliable: modern Node closes the
// IncomingMessage of a fully consumed GET while its response is still pending,
// so every search that outlived its own (empty) body was treated as
// client-gone — silently dropped. Mirrors scanHttpCancellation.test.ts: only
// the unfinished RESPONSE closing means the consumer went away.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function start(app: express.Express): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: address.port,
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('a completed incoming GET stays active until the response client disconnects', { timeout: 5000 }, async (t) => {
  const incomingClosed = deferred<void>();
  const started = deferred<() => boolean>();
  const done = deferred<SearchResult>();
  const app = express();
  app.use((req, _res, next) => {
    req.once('close', () => incomingClosed.resolve());
    req.resume();
    next();
  });
  app.use(buildSearchRouter('search-http-fixture', async (_root, opts) => {
    assert.ok(opts.isCancelled);
    started.resolve(opts.isCancelled);
    return done.promise;
  }));
  const { port, stop } = await start(app);
  t.after(stop);
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/search?q=needle`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    request.on('error', reject);
  });
  const isCancelled = await started.promise;
  await incomingClosed.promise;
  assert.equal(isCancelled(), false, 'normal incoming-request close must not cancel a held GET');
  done.resolve({ matches: ['C:\\proj\\a.ts'], scanned: 1, truncated: false });
  const received = await response;
  assert.equal(received.status, 200);
  assert.deepEqual(JSON.parse(received.body).matches, ['C:\\proj\\a.ts']);
  assert.equal(isCancelled(), false, 'normal response completion must not signal cancellation');
});

test('destroying a held GET response cancels the search', { timeout: 5000 }, async (t) => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  const app = express();
  app.use(buildSearchRouter('search-http-fixture', async (_root, opts) => {
    started.resolve();
    while (!opts.isCancelled?.()) {
      await new Promise((r) => setTimeout(r, 5));
    }
    cancelled.resolve();
    return { matches: [], scanned: 0, truncated: true };
  }));
  const { port, stop } = await start(app);
  t.after(stop);
  const request = http.get(`http://127.0.0.1:${port}/api/search?q=needle`);
  request.on('error', () => {});
  await started.promise;
  request.destroy();
  await cancelled.promise;
});
